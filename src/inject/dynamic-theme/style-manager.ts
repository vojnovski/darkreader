import {iterateCSSRules, iterateCSSDeclarations, replaceCSSRelativeURLsWithAbsolute, replaceCSSFontFace, replaceCSSVariables, getCSSURLValue, cssImportRegex, getCSSBaseBath} from './css-rules';
import {getModifiableCSSDeclaration, ModifiableCSSDeclaration, ModifiableCSSRule} from './modify-css';
import {bgFetch} from './network';
import {removeNode, watchForNodePosition} from '../utils/dom';
import {throttle} from '../utils/throttle';
import {logWarn} from '../utils/log';
import {isDeepSelectorSupported} from '../../utils/platform';
import {getMatches} from '../../utils/text';
import {FilterConfig} from '../../definitions';
import {getAbsoluteURL} from './url';

declare global {
    interface HTMLStyleElement {
        sheet: CSSStyleSheet;
    }
    interface HTMLLinkElement {
        sheet: CSSStyleSheet;
    }
}

export interface StyleManager {
    details(): {variables: Map<string, string>};
    render(filter: FilterConfig, variables: Map<string, string>): void;
    pause(): void;
    destroy(): void;
    watch(): void;
}

export const STYLE_SELECTOR = isDeepSelectorSupported()
    ? 'html /deep/ link[rel*="stylesheet" i], html /deep/ style'
    : 'html link[rel*="stylesheet" i], html style';

export function shouldManageStyle(element: Node) {
    return (
        (
            (element instanceof HTMLStyleElement) ||
            (element instanceof HTMLLinkElement && element.rel && element.rel.toLowerCase().includes('stylesheet'))
        ) &&
        !element.classList.contains('darkreader') &&
        element.media !== 'print'
    );
}

export function manageStyle(element: HTMLLinkElement | HTMLStyleElement, {update, loadingStart, loadingEnd}): StyleManager {

    const prevStyles: HTMLStyleElement[] = [];
    let next: Element = element;
    while ((next = next.nextElementSibling) && next.matches('.darkreader')) {
        prevStyles.push(next as HTMLStyleElement);
    }
    let corsCopy: HTMLStyleElement = prevStyles.find((el) => el.matches('.darkreader--cors')) || null;
    let syncStyle: HTMLStyleElement = prevStyles.find((el) => el.matches('.darkreader--sync')) || null;

    let corsCopyPositionWatcher: ReturnType<typeof watchForNodePosition> = null;
    let syncStylePositionWatcher: ReturnType<typeof watchForNodePosition> = null;

    let cancelAsyncOperations = false;

    function isCancelled() {
        return cancelAsyncOperations;
    }

    const observer = new MutationObserver((mutations) => {
        update();
    });
    const observerOptions: MutationObserverInit = {attributes: true, childList: true, characterData: true};

    function containsCSSImport() {
        return element instanceof HTMLStyleElement && element.textContent.trim().match(cssImportRegex);
    }

    function getRulesSync(): CSSRuleList {
        if (corsCopy) {
            return corsCopy.sheet.cssRules;
        }
        if (element.sheet == null) {
            return null;
        }
        if (element instanceof HTMLLinkElement) {
            try {
                return element.sheet.cssRules;
            } catch (err) {
                logWarn(err);
                return null;
            }
        }
        if (containsCSSImport()) {
            return null;
        }
        return element.sheet.cssRules;
    }

    let isLoadingRules = false;
    let wasLoadingError = false;

    async function getRulesAsync(): Promise<CSSRuleList> {
        let cssText: string;
        let cssBasePath: string;

        if (element instanceof HTMLLinkElement) {
            if (element.sheet == null) {
                try {
                    await linkLoading(element);
                    if (cancelAsyncOperations) {
                        return null;
                    }
                } catch (err) {
                    logWarn(err);
                    wasLoadingError = true;
                    return null;
                }
            }
            try {
                if (element.sheet.cssRules != null) {
                    return element.sheet.cssRules;
                }
            } catch (err) {
                logWarn(err);
            }
            cssText = await loadWithCache(element.href);
            cssBasePath = getCSSBaseBath(element.href);
            if (cancelAsyncOperations) {
                return null;
            }
        } else if (containsCSSImport()) {
            cssText = element.textContent.trim();
            cssBasePath = getCSSBaseBath(location.href);
        } else {
            return null;
        }

        if (cssText) {
            // Sometimes cross-origin stylesheets are protected from direct access
            // so need to load CSS text and insert it into style element
            try {
                const fullCSSText = await replaceCSSImports(cssText, cssBasePath);
                corsCopy = createCORSCopy(element, fullCSSText);
                corsCopyPositionWatcher = watchForNodePosition(corsCopy);
            } catch (err) {
                logWarn(err);
            }
            if (corsCopy) {
                return corsCopy.sheet.cssRules;
            }
        }

        return null;
    }

    function getVariables(rules: CSSRuleList) {
        const variables = new Map<string, string>();
        rules && iterateCSSRules(rules, (rule) => {
            rule.style && iterateCSSDeclarations(rule.style, (property, value) => {
                if (property.startsWith('--')) {
                    variables.set(property, value);
                }
            });
        });
        return variables;
    }

    function details() {
        const rules = getRulesSync();
        if (!rules) {
            if (isLoadingRules || wasLoadingError) {
                return null;
            }
            isLoadingRules = true;
            loadingStart();
            getRulesAsync().then((results) => {
                isLoadingRules = false;
                loadingEnd();
                if (results) {
                    update();
                }
            }).catch((err) => {
                logWarn(err);
                isLoadingRules = false;
                loadingEnd();
            });
            return null;
        }
        const variables = getVariables(rules);
        return {variables};
    }

    function getFilterKey(filter: FilterConfig) {
        return ['mode', 'brightness', 'contrast', 'grayscale', 'sepia'].map((p) => `${p}:${filter[p]}`).join(';');
    }

    let renderId = 0;
    const rulesTextCache = new Map<string, string>();
    const rulesModCache = new Map<string, ModifiableCSSRule>();
    let prevFilterKey: string = null;

    function render(filter: FilterConfig, variables: Map<string, string>) {
        const rules = getRulesSync();
        if (!rules) {
            return;
        }

        cancelAsyncOperations = false;
        let rulesChanged = (rulesModCache.size === 0);
        const notFoundCacheKeys = new Set(rulesModCache.keys());
        const filterKey = getFilterKey(filter);
        let filterChanged = (filterKey !== prevFilterKey);

        const modRules: ModifiableCSSRule[] = [];
        iterateCSSRules(rules, (rule) => {
            let cssText = rule.cssText;
            let textDiffersFromPrev = false;

            notFoundCacheKeys.delete(cssText);
            if (!rulesTextCache.has(cssText)) {
                rulesTextCache.set(cssText, cssText);
                textDiffersFromPrev = true;
            }

            // Put CSS text with inserted CSS variables into separate <style> element
            // to properly handle composite properties (e.g. background -> background-color)
            let vars: HTMLStyleElement = null;
            let varsRule: CSSStyleRule = null;
            if (variables.size > 0) {
                const cssTextWithVariables = replaceCSSVariables(cssText, variables);
                if (rulesTextCache.get(cssText) !== cssTextWithVariables) {
                    rulesTextCache.set(cssText, cssTextWithVariables);
                    textDiffersFromPrev = true;
                    vars = document.createElement('style');
                    vars.classList.add('darkreader');
                    vars.classList.add('darkreader--vars');
                    vars.media = 'screen';
                    vars.textContent = cssTextWithVariables;
                    element.parentNode.insertBefore(vars, element.nextSibling);
                    varsRule = (vars.sheet as CSSStyleSheet).cssRules[0] as CSSStyleRule;
                }
            }

            if (textDiffersFromPrev) {
                rulesChanged = true;
            } else {
                modRules.push(rulesModCache.get(cssText));
                return;
            }

            const modDecs: ModifiableCSSDeclaration[] = [];
            const targetRule = varsRule || rule;
            targetRule && targetRule.style && iterateCSSDeclarations(targetRule.style, (property, value) => {
                const mod = getModifiableCSSDeclaration(property, value, rule, isCancelled);
                if (mod) {
                    modDecs.push(mod);
                }
            });

            let modRule: ModifiableCSSRule = null;
            if (modDecs.length > 0) {
                modRule = {selector: rule.selectorText, declarations: modDecs};
                if (rule.parentRule instanceof CSSMediaRule) {
                    modRule.media = (rule.parentRule as CSSMediaRule).media.mediaText;
                }
                modRules.push(modRule);
            }
            rulesModCache.set(cssText, modRule);

            removeNode(vars);
        });

        notFoundCacheKeys.forEach((key) => {
            rulesTextCache.delete(key);
            rulesModCache.delete(key);
        });
        prevFilterKey = filterKey;

        if (!rulesChanged && !filterChanged) {
            return;
        }

        renderId++;

        interface ReadyDeclaration {
            media: string;
            selector: string;
            property: string;
            value: string;
            important: boolean;
        }

        const readyDeclarations: ReadyDeclaration[] = [];

        function buildStyleSheet() {
            const groups: ReadyDeclaration[][] = [];
            readyDeclarations.filter((d) => d).forEach((decl) => {
                let group: ReadyDeclaration[];
                const prev = groups.length > 0 ? groups[groups.length - 1] : null;
                if (prev && prev[0].selector === decl.selector && prev[0].media === decl.media) {
                    group = prev;
                } else {
                    group = [];
                    groups.push(group);
                }
                group.push(decl);
            });

            const lines: string[] = [];
            groups.forEach((group) => {
                const {media, selector} = group[0];
                if (media) {
                    lines.push(`@media ${media} {`);
                }
                lines.push(`${selector} {`);
                group.forEach(({property, value, important}) => {
                    lines.push(`    ${property}: ${value}${important ? ' !important' : ''};`);
                });
                lines.push('}');
                if (media) {
                    lines.push('}')
                }
            });

            if (!syncStyle) {
                syncStyle = document.createElement('style');
                syncStyle.classList.add('darkreader');
                syncStyle.classList.add('darkreader--sync');
                syncStyle.media = 'screen';
            }
            syncStylePositionWatcher && syncStylePositionWatcher.stop();
            element.parentNode.insertBefore(syncStyle, corsCopy ? corsCopy.nextSibling : element.nextSibling);
            syncStyle.textContent = lines.join('\n');
            syncStylePositionWatcher = watchForNodePosition(syncStyle);
        }

        const RULES_PER_MS = 100;
        const REQUESTED_RESOURCES = 1 / 4;
        const declarationsCount = modRules.filter((r) => r).reduce((total, {declarations}) => total + declarations.length, 0);
        const timeout = declarationsCount / RULES_PER_MS / REQUESTED_RESOURCES;

        const throttledBuildStyleSheet = throttle((currentRenderId: number) => {
            if (cancelAsyncOperations || renderId !== currentRenderId) {
                return;
            }
            buildStyleSheet();
        }, timeout);

        modRules.filter((r) => r).forEach(({selector, declarations, media}) => {
            declarations.forEach(({property, value, important}) => {
                if (typeof value === 'function') {
                    const modified = value(filter);
                    if (modified instanceof Promise) {
                        const index = readyDeclarations.length;
                        readyDeclarations.push(null);
                        const promise = modified;
                        const currentRenderId = renderId;
                        promise.then((asyncValue) => {
                            if (!asyncValue || cancelAsyncOperations || currentRenderId !== renderId) {
                                return;
                            }
                            readyDeclarations[index] = {media, selector, property, value: asyncValue, important};
                            throttledBuildStyleSheet(currentRenderId);
                        });
                    } else {
                        readyDeclarations.push({media, selector, property, value: modified, important});
                    }
                } else {
                    readyDeclarations.push({media, selector, property, value, important});
                }
            });
        });

        throttledBuildStyleSheet(renderId);
    }

    let rulesCount: number = null;
    let rulesCheckFrameId: number = null;

    function subscribeToSheetChanges() {
        if (element.sheet && element.sheet.cssRules) {
            rulesCount = element.sheet.cssRules.length;
        }
        unsubscribeFromSheetChanges();
        const checkForUpdate = () => {
            if (element.sheet && element.sheet.cssRules &&
                element.sheet.cssRules.length !== rulesCount
            ) {
                rulesCount = element.sheet.cssRules.length;
                update();
            }
            rulesCheckFrameId = requestAnimationFrame(checkForUpdate);
        };
        checkForUpdate();
    }

    function unsubscribeFromSheetChanges() {
        cancelAnimationFrame(rulesCheckFrameId);
    }

    function pause() {
        observer.disconnect();
        corsCopyPositionWatcher && corsCopyPositionWatcher.stop();
        syncStylePositionWatcher && syncStylePositionWatcher.stop();
        cancelAsyncOperations = true;
        unsubscribeFromSheetChanges();
    }

    function destroy() {
        pause();
        removeNode(corsCopy);
        removeNode(syncStyle);
    }

    function watch() {
        observer.observe(element, observerOptions);
        if (element instanceof HTMLStyleElement) {
            subscribeToSheetChanges();
        }
    }

    return {
        details,
        render,
        pause,
        destroy,
        watch,
    };
}

function linkLoading(link: HTMLLinkElement) {
    return new Promise<void>((resolve, reject) => {
        const cleanUp = () => {
            link.removeEventListener('load', onLoad);
            link.removeEventListener('error', onError);
        }
        const onLoad = () => {
            cleanUp();
            resolve();
        };
        const onError = () => {
            cleanUp();
            reject(`Link loading failed ${link.href}`);
        };
        link.addEventListener('load', onLoad);
        link.addEventListener('error', onError);
    });
}

function getCSSImportURL(importDeclaration: string) {
    return getCSSURLValue(importDeclaration.substring(8).replace(/;$/, ''));
}

async function loadWithCache(url: string) {
    if (url.startsWith('data:')) {
        return await (await fetch(url)).text();
    }

    let response: string;
    let cache: string;
    try {
        cache = sessionStorage.getItem(`darkreader-cache:${url}`);
    } catch (err) {
        logWarn(err);
    }
    if (cache) {
        response = cache;
    } else {
        response = await bgFetch({url, responseType: 'text'});
        if (response.length < 2 * 1024 * 1024) {
            try {
                sessionStorage.setItem(`darkreader-cache:${url}`, response);
            } catch (err) {
                logWarn(err);
            }
        }
    }
    return response;
}

async function replaceCSSImports(cssText: string, basePath: string) {
    cssText = replaceCSSFontFace(cssText);
    cssText = replaceCSSRelativeURLsWithAbsolute(cssText, basePath);

    const importMatches = getMatches(cssImportRegex, cssText);
    for (let match of importMatches) {
        const importURL = getCSSImportURL(match);
        const absoluteURL = getAbsoluteURL(basePath, importURL);
        let importedCSS: string;
        try {
            importedCSS = await loadWithCache(absoluteURL);
            importedCSS = await replaceCSSImports(importedCSS, getCSSBaseBath(absoluteURL));
        } catch (err) {
            logWarn(err);
            importedCSS = '';
        }
        cssText = cssText.split(match).join(importedCSS);
    }

    cssText = cssText.trim();

    return cssText;
}

function createCORSCopy(srcElement: HTMLLinkElement | HTMLStyleElement, cssText: string) {
    if (!cssText) {
        return null;
    }

    const cors = document.createElement('style');
    cors.classList.add('darkreader');
    cors.classList.add('darkreader--cors');
    cors.media = 'screen';
    cors.textContent = cssText;
    srcElement.parentNode.insertBefore(cors, srcElement.nextSibling);
    cors.sheet.disabled = true;

    return cors;
}
