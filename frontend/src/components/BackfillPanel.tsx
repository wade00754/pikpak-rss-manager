import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { api } from '../lib/api.js';
import { errorMessage, isCancelled } from '../lib/i18n.js';
import { useLifetime } from '../lib/lifetime.js';
import type { BackfillPlan } from '../lib/types.js';
import { DirtyForm } from './DirtyForm.js';
import { Icon } from './Icon.js';
import { usePreferences } from './Preferences.js';

export function BackfillPanel({
    subscriptionID,
    onClose,
    onSaved,
}: {
    subscriptionID: number;
    onClose: () => void;
    onSaved: () => Promise<void>;
}): JSX.Element {
    const { t } = usePreferences();
    const active = useLifetime();
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [plan, setPlan] = useState<BackfillPlan | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const available =
        plan?.items.filter((item) => !item.error).map((item) => item.id) ?? [];
    const selectedCount = available.filter((id) =>
        selected.includes(id)
    ).length;
    const allSelected =
        available.length > 0 && selectedCount === available.length;
    const partiallySelected = selectedCount > 0 && !allSelected;
    useEffect(() => {
        const controller = new AbortController();
        void api<BackfillPlan>(
            `/api/subscriptions/${subscriptionID}/backfill/preview`,
            'POST',
            {},
            controller.signal
        )
            .then((value) => {
                if (!controller.signal.aborted) {
                    setPlan(value);
                }
            })
            .catch((error_: unknown) => {
                if (!controller.signal.aborted && !isCancelled(error_)) {
                    setError(errorMessage(error_));
                }
            });
        return () => {
            controller.abort();
        };
    }, [subscriptionID]);
    return (
        <form
            id='backfill-form'
            onSubmit={(event) => {
                event.preventDefault();
                if (
                    !plan ||
                    selected.length === 0 ||
                    pending ||
                    !globalThis.confirm(t('下載所選項目？'))
                ) {
                    return;
                }
                setPending(true);
                setSubmitted(true);
                setError('');
                void api(
                    `/api/subscriptions/${subscriptionID}/backfill`,
                    'POST',
                    { token: plan.token, selected }
                )
                    .then(onSaved)
                    .then(() => {
                        if (active.current) {
                            onClose();
                        }
                    })
                    .catch((error_: unknown) => {
                        setError(errorMessage(error_));
                    })
                    .finally(() => {
                        setPending(false);
                    });
            }}
        >
            <DirtyForm dirty={pending || selected.length > 0} />
            <p className='field-help'>
                {t(
                    '勾選要下載的種子；多檔種子會下載整筆內容，保留原始目錄結構。'
                )}
            </p>
            <p
                className={`field-help${error ? ' error' : ''}`}
                id='backfill-status'
                role='status'
            >
                {error
                    ? t(error)
                    : plan
                      ? [
                            plan.items.length === 0
                                ? t('RSS 中沒有可下載的項目')
                                : '',
                            ...plan.notices.map(t),
                        ]
                            .filter(Boolean)
                            .join(' ')
                      : t('正在讀取下載清單…')}
            </p>
            <label className='checkbox-label'>
                <input
                    checked={allSelected}
                    disabled={available.length === 0 || submitted}
                    id='backfill-select-all'
                    onChange={(event) => {
                        setSelected(event.target.checked ? available : []);
                    }}
                    ref={(input) => {
                        if (input) {
                            input.indeterminate = partiallySelected;
                        }
                    }}
                    type='checkbox'
                />
                <span>{t('全選')}</span>
            </label>
            <div id='backfill-list'>
                {plan?.items.map((item) => (
                    <label className='backfill-choice' key={item.id}>
                        <input
                            checked={selected.includes(item.id)}
                            disabled={submitted || Boolean(item.error)}
                            onChange={(event) => {
                                setSelected((values) =>
                                    event.target.checked
                                        ? [...values, item.id]
                                        : values.filter((id) => id !== item.id)
                                );
                            }}
                            type='checkbox'
                            value={item.id}
                        />
                        <span>
                            <strong>{item.title}</strong>
                            {item.filenames?.map((name) => (
                                <code key={name}>{name}</code>
                            ))}
                            {!item.filenames?.length && (
                                <small>{t('無法取得種子檔名')}</small>
                            )}
                            {item.error && (
                                <small className='error'>{t(item.error)}</small>
                            )}
                        </span>
                    </label>
                ))}
            </div>
            <div className='dialog-footer'>
                <button
                    className='button subtle'
                    disabled={pending}
                    onClick={() => {
                        if (
                            selected.length === 0 ||
                            globalThis.confirm(t('放棄未儲存的變更？'))
                        ) {
                            onClose();
                        }
                    }}
                    type='button'
                >
                    {t('取消')}
                </button>
                <button
                    aria-busy={pending}
                    className='button primary'
                    disabled={!plan || selected.length === 0 || pending}
                    id='backfill-download'
                    type='submit'
                >
                    {pending && <Icon className='is-loading' name='loading' />}
                    {t('下載所選項目')}
                </button>
            </div>
        </form>
    );
}
