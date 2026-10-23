import type { JSX } from 'react';

export function ProgressMeter({
    value,
    label,
    valueText,
    kind = 'progressbar',
    warning = false,
    shape = 'line',
}: {
    value?: number;
    label: string;
    valueText?: string;
    kind?: 'progressbar' | 'meter';
    warning?: boolean;
    shape?: 'line' | 'circle';
}): JSX.Element {
    const unknown = value === undefined;
    const percent = Math.min(100, Math.max(0, value ?? 0));
    return (
        <span
            aria-label={
                unknown && valueText ? `${label} · ${valueText}` : label
            }
            aria-valuemax={unknown ? undefined : 100}
            aria-valuemin={unknown ? undefined : 0}
            aria-valuenow={unknown ? undefined : percent}
            aria-valuetext={unknown ? undefined : valueText}
            className={`progress-meter${shape === 'circle' ? ' is-circular' : ''}${warning ? ' is-warning' : ''}`}
            role={unknown ? 'img' : kind}
        >
            {shape === 'circle' ? (
                <svg aria-hidden='true' viewBox='0 0 24 24'>
                    <circle className='meter-track' cx='12' cy='12' r='9' />
                    {percent > 0 && (
                        <circle
                            className='meter-fill'
                            cx='12'
                            cy='12'
                            pathLength='100'
                            r='9'
                            strokeDasharray={`${percent} 100`}
                            transform='rotate(-90 12 12)'
                        />
                    )}
                </svg>
            ) : (
                <svg
                    aria-hidden='true'
                    preserveAspectRatio='none'
                    viewBox='0 0 100 4'
                >
                    <rect className='meter-track' height='4' width='100' />
                    <rect className='meter-fill' height='4' width={percent} />
                </svg>
            )}
        </span>
    );
}
