import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { api } from '../lib/api.js';
import { errorMessage, isCancelled } from '../lib/i18n.js';
import type {
    RenameResult,
    Rule,
    SampleResult,
    SourceSample,
} from '../lib/types.js';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { usePreferences } from './Preferences.js';
import { Select } from './Select.js';

export function RenamePreview({
    url,
    subscriptionID,
    rule,
    paused = false,
}: {
    url: string;
    subscriptionID: number;
    rule: Rule;
    paused?: boolean;
}): JSX.Element {
    const { t } = usePreferences();
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [notices, setNotices] = useState<string[]>([]);
    const [renderedRule, setRenderedRule] = useState('');
    const [pending, setPending] = useState(false);
    const [result, setResult] = useState<RenameResult | null>(null);
    const [samples, setSamples] = useState<SourceSample[]>([]);
    const [selected, setSelected] = useState('0');
    const request = useRef<AbortController | null>(null);
    const autoLoad = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    const selectedSample = useRef<SourceSample | undefined>(undefined);
    const sourceURL = url.trim();
    const canLoad =
        URL.canParse(sourceURL) &&
        ['http:', 'https:'].includes(new URL(sourceURL).protocol);
    const filename = samples.at(Number(selected))?.filename;
    const { title, regex, rename_enabled: renameEnabled, replacement } = rule;
    const signature = JSON.stringify([
        filename,
        title,
        regex,
        replacement,
        renameEnabled,
        paused,
    ]);
    const currentResult = renderedRule === signature ? result : null;
    const currentError = renderedRule === signature ? error : '';
    useEffect(() => {
        if (!filename || paused) {
            return;
        }
        const controller = new AbortController();
        const timer = globalThis.setTimeout(() => {
            void api<RenameResult>(
                '/api/rules/preview',
                'POST',
                {
                    rule: {
                        title,
                        regex,
                        replacement,
                        rename_enabled: renameEnabled,
                    },
                    filename,
                },
                controller.signal
            )
                .then((value) => {
                    if (!controller.signal.aborted) {
                        setResult(value);
                        setRenderedRule(signature);
                        setError('');
                    }
                })
                .catch((error_: unknown) => {
                    if (!controller.signal.aborted && !isCancelled(error_)) {
                        setError(errorMessage(error_));
                        setRenderedRule(signature);
                        setResult(null);
                    }
                });
        }, 200);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [filename, title, regex, replacement, renameEnabled, signature, paused]);
    const load = useCallback(async () => {
        if (!canLoad) {
            return;
        }
        clearTimeout(autoLoad.current);
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setPending(true);
        setNotices([]);
        setNotice('正在讀取全部種子檔名…');
        try {
            const response = await api<SampleResult>(
                '/api/feeds/samples',
                'POST',
                { url: sourceURL, subscription_id: subscriptionID },
                controller.signal
            );
            if (controller.signal.aborted) {
                return;
            }
            const known = new Set<string>();
            const items = response.items.filter((sample) => {
                const key = JSON.stringify([sample.title, sample.filename]);
                if (sample.kind !== 'torrent_file' || known.has(key)) {
                    return false;
                }
                known.add(key);
                return true;
            });
            setSamples(items);
            const previous = selectedSample.current;
            const index = items.findIndex(
                (sample) =>
                    sample.title === previous?.title &&
                    sample.filename === previous.filename
            );
            setSelected(String(Math.max(0, index)));
            selectedSample.current = items.at(Math.max(0, index));
            setNotices([...new Set(response.notices)]);

            setNotice(
                items.length > 0
                    ? `已讀取 ${items.length} 個種子檔名。`
                    : '目前 RSS 沒有可用的種子檔名。'
            );
        } catch (error_) {
            if (!controller.signal.aborted && !isCancelled(error_)) {
                setNotice(errorMessage(error_));
            }
        } finally {
            if (!controller.signal.aborted) {
                setPending(false);
            }
        }
    }, [canLoad, sourceURL, subscriptionID]);
    useEffect(() => {
        if (canLoad && renameEnabled) {
            autoLoad.current = globalThis.setTimeout(() => {
                void load();
            }, 500);
        }
        return () => {
            clearTimeout(autoLoad.current);
            request.current?.abort();
        };
    }, [canLoad, renameEnabled, load]);
    return (
        <div className='preview-box'>
            <div className='preview-heading'>
                <h3>{t('檔名預覽')}</h3>
                <button
                    aria-busy={pending}
                    aria-label={t('重新整理種子檔名')}
                    className='icon-button preview-refresh'
                    disabled={pending || !canLoad}
                    id='source-samples'
                    onClick={() => {
                        void load();
                    }}
                    title={t('重新整理種子檔名')}
                    type='button'
                >
                    <Icon name='refresh' />
                </button>
            </div>
            {samples.length > 0 && (
                <FormField id='preview-source' label={t('種子檔名')}>
                    <Select
                        className='filename-select'
                        onValueChange={(value) => {
                            setSelected(value);
                            selectedSample.current = samples.at(Number(value));
                        }}
                        options={samples.map((sample, index) => ({
                            value: String(index),
                            label: sample.filename,
                        }))}
                        value={selected}
                    />
                </FormField>
            )}
            <p className='field-help' id='preview-source-help' role='status'>
                {[
                    t(canLoad ? notice : '請填寫有效的 RSS 連結'),
                    ...notices.map(t),
                ]
                    .filter(Boolean)
                    .join(' ')}
            </p>
            <div
                aria-live='polite'
                className={`preview-result${currentError ? ' error' : currentResult ? ' success' : ''}`}
                id='preview-result'
            >
                {currentError ? (
                    t(currentError)
                ) : filename ? (
                    currentResult ? (
                        <>
                            <div className='rename-preview-row'>
                                <span>{t('替換結果')}</span>
                                <code>{currentResult.name}</code>
                            </div>
                            {currentResult.raw_name !== undefined &&
                                currentResult.raw_name !==
                                    currentResult.name && (
                                    <p className='preview-warning'>
                                        {currentResult.warnings
                                            ?.map(t)
                                            .join(' ')}
                                    </p>
                                )}
                        </>
                    ) : (
                        t('正在更新預覽…')
                    )
                ) : (
                    t('選擇種子檔名')
                )}
            </div>
        </div>
    );
}
