import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { storageSummary } from '../lib/storage.js';
import type { Status, Subscription } from '../lib/types.js';
import { Icon } from './Icon.js';
import { usePreferences } from './Preferences.js';
import { ProgressMeter } from './ProgressMeter.js';

function StorageMeter({ status }: { status: Status }): JSX.Element {
    const { language, t } = usePreferences();
    const summary = storageSummary(status);
    const { capacity = '', percent = 0 } = summary ?? {};
    const free = summary ? t(`剩餘 ${summary.free}`) : '';
    const updated = status.storage_updated_at
        ? t(
              `上次更新 ${new Date(status.storage_updated_at * 1000).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}`
          )
        : '';
    return (
        <section
            aria-label={t('PikPak 空間')}
            className='storage-stat'
            title={
                summary
                    ? [free, updated].filter(Boolean).join(' · ')
                    : undefined
            }
        >
            <Icon name='storage' />
            <div className='workspace-stat storage-stat-content'>
                <div className='workspace-stat-text'>
                    <span>{summary ? capacity : t('空間資料暫不可用')}</span>
                    {summary && (
                        <span className='storage-percent'>
                            {Math.round(percent)}%
                        </span>
                    )}
                </div>
                <ProgressMeter
                    kind='meter'
                    label={t('PikPak 空間')}
                    value={summary ? percent : undefined}
                    valueText={
                        summary
                            ? `${capacity} · ${free}`
                            : t('空間資料暫不可用')
                    }
                    warning={percent >= 90}
                />
            </div>
        </section>
    );
}

function RssSchedule({
    subscriptions,
    status,
    checking,
    onCheck,
}: {
    subscriptions: Subscription[];
    status: Status;
    checking: boolean;
    onCheck?: () => void;
}): JSX.Element {
    const { t } = usePreferences();
    const [now, setNow] = useState(() => Date.now() / 1000);
    useEffect(() => {
        const tick = () => {
            if (!document.hidden) {
                setNow(Date.now() / 1000);
            }
        };
        const timer = globalThis.setInterval(tick, 15_000);
        const immediate = globalThis.setTimeout(tick, 0);
        document.addEventListener('visibilitychange', tick);
        return () => {
            clearInterval(timer);
            clearTimeout(immediate);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [subscriptions]);
    const next = subscriptions
        .filter((sub) => sub.enabled)
        .toSorted((a, b) => (a.next_check || 0) - (b.next_check || 0))
        .at(0);
    const seconds = Math.max(0, (next?.next_check ?? 0) - now);
    const active = Boolean(next && status.connected && !status.paused);
    const label =
        !status.connected || status.paused
            ? t('RSS 已暫停')
            : next
              ? seconds <= 0
                  ? t('即將檢查')
                  : seconds <= 60
                    ? t(`${Math.ceil(seconds)} 秒後`)
                    : t(`${Math.ceil(seconds / 60)} 分鐘後`)
              : t('尚無啟用訂閱');
    const elapsed = next
        ? 100 * (1 - seconds / Math.max(1, next.interval_minutes * 60))
        : 0;
    return (
        <section aria-label={t('下次 RSS 檢查')} className='rss-schedule'>
            <button
                aria-busy={checking}
                aria-describedby='rss-next-check-label'
                aria-label={t('立即檢查 RSS')}
                className='icon-button rss-refresh'
                disabled={!active || checking || !onCheck}
                id='check-all-subscriptions'
                onClick={onCheck}
                title={t('檢查所有啟用的 RSS 訂閱')}
                type='button'
            >
                <Icon
                    className={checking ? 'is-loading' : undefined}
                    name='refresh'
                />
            </button>
            <div className='workspace-stat rss-schedule-content'>
                <span className='workspace-stat-text' id='rss-next-check-label'>
                    {checking ? (
                        t('正在檢查…')
                    ) : (
                        <>
                            {t('下次檢查')}{' '}
                            <span className='rss-countdown'>· {label}</span>
                        </>
                    )}
                </span>
                <ProgressMeter
                    kind='meter'
                    label={t('RSS 檢查週期')}
                    value={active ? elapsed : undefined}
                    valueText={label}
                />
            </div>
        </section>
    );
}

export function WorkspaceSummary({
    status,
    subscriptions,
    checking = false,
    onCheck,
}: {
    status: Status;
    subscriptions: Subscription[];
    checking?: boolean;
    onCheck?: () => void;
}): JSX.Element {
    return (
        <div className='workspace-summary'>
            <RssSchedule
                checking={checking}
                onCheck={onCheck}
                status={status}
                subscriptions={subscriptions}
            />
            <StorageMeter status={status} />
        </div>
    );
}
