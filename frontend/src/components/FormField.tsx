import { cloneElement, useId, useRef } from 'react';
import type { JSX, ReactElement, ReactNode } from 'react';

import { Icon } from './Icon.js';

export function InfoHelp({
    id,
    label,
    children,
}: {
    id: string;
    label: string;
    children: ReactNode;
}): JSX.Element {
    const trigger = useRef<HTMLButtonElement>(null);
    return (
        <>
            <button
                aria-label={label}
                className='info-trigger'
                popoverTarget={id}
                ref={trigger}
                type='button'
            >
                <Icon name='info' />
            </button>
            <div
                className='field-popover'
                id={id}
                onToggle={(event) => {
                    const button = trigger.current;
                    const popover = event.currentTarget;
                    if (!button || !popover.matches(':popover-open')) {
                        return;
                    }
                    const rect = button.getBoundingClientRect();
                    popover.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 16))}px`;
                    popover.style.top = `${rect.bottom + 8 + popover.offsetHeight <= window.innerHeight - 16 ? rect.bottom + 8 : Math.max(16, rect.top - popover.offsetHeight - 8)}px`;
                }}
                popover='auto'
            >
                <p>{children}</p>
            </div>
        </>
    );
}
export function FormField({
    id,
    label,
    help,
    info,
    children,
    className = '',
    wrapperId,
}: {
    id: string;
    label: ReactNode;
    help?: ReactNode;
    info?: { id?: string; label: string; content: ReactNode };
    children: ReactElement<{ 'id'?: string; 'aria-describedby'?: string }>;
    className?: string;
    wrapperId?: string;
}): JSX.Element {
    const description = help
        ? `${id}-help`
        : info
          ? info.id || `${id}-info`
          : undefined;
    return (
        <div className={`form-field ${className}`} id={wrapperId}>
            {info ? (
                <div className='field-label-row'>
                    <label htmlFor={id}>{label}</label>
                    <InfoHelp id={info.id || `${id}-info`} label={info.label}>
                        {info.content}
                    </InfoHelp>
                </div>
            ) : (
                <label htmlFor={id}>{label}</label>
            )}
            {cloneElement(children, { id, 'aria-describedby': description })}
            {help && (
                <div className='field-help' id={description}>
                    {help}
                </div>
            )}
        </div>
    );
}
export function CheckboxField({
    id,
    label,
    checked,
    onChange,
    help,
    info,
    className = '',
}: {
    id: string;
    label: ReactNode;
    checked: boolean;
    onChange: (value: boolean) => void;
    help?: ReactNode;
    info?: { id: string; label: string; content: ReactNode };
    className?: string;
}): JSX.Element {
    const generated = useId();
    const description = info?.id || (help ? generated : undefined);
    const control = (
        <label className='checkbox-label'>
            <input
                aria-describedby={description}
                checked={checked}
                id={id}
                onChange={(event) => {
                    onChange(event.target.checked);
                }}
                type='checkbox'
            />
            <span>{label}</span>
        </label>
    );
    return (
        <div className={`form-field ${className}`}>
            {info ? (
                <div className='field-label-row'>
                    {control}
                    <InfoHelp id={info.id} label={info.label}>
                        {info.content}
                    </InfoHelp>
                </div>
            ) : (
                control
            )}
            {help && (
                <p className='field-help' id={description}>
                    {help}
                </p>
            )}
        </div>
    );
}
export function Feedback({
    message,
    status = false,
}: {
    message: string;
    status?: boolean;
}): JSX.Element | null {
    return message ? (
        <p className='form-feedback' role={status ? 'status' : 'alert'}>
            {message}
        </p>
    ) : null;
}
