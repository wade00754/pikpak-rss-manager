import type { JSX } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';

import { Icon } from './Icon.js';

interface SelectProps {
    'className'?: string;
    'disabled'?: boolean;
    'id'?: string;
    'aria-label'?: string;
    'aria-describedby'?: string;
    'value': string;
    'onValueChange': (value: string) => void;
    'options': Array<{ value: string; label: string; disabled?: boolean }>;
}

export function Select({
    className = '',
    disabled,
    value,
    onValueChange,
    options,
    ...props
}: SelectProps): JSX.Element {
    return (
        <SelectPrimitive.Root
            disabled={disabled}
            onValueChange={onValueChange}
            value={value}
        >
            <div className={`select-control ${className}`}>
                <SelectPrimitive.Trigger {...props} className='select-trigger'>
                    <span className='select-value'>
                        <SelectPrimitive.Value />
                    </span>
                    <SelectPrimitive.Icon asChild>
                        <Icon className='select-chevron' name='chevron' />
                    </SelectPrimitive.Icon>
                </SelectPrimitive.Trigger>
                <SelectPrimitive.Content
                    align='start'
                    className={`select-menu ${className}`}
                    collisionPadding={16}
                    position='popper'
                    sideOffset={8}
                >
                    <SelectPrimitive.ScrollUpButton className='select-scroll select-scroll-up'>
                        <Icon name='chevron' />
                    </SelectPrimitive.ScrollUpButton>
                    <SelectPrimitive.Viewport className='select-options'>
                        {options.map((option) => (
                            <SelectPrimitive.Item
                                className='select-option'
                                disabled={option.disabled}
                                key={option.value}
                                title={option.label}
                                value={option.value}
                            >
                                <SelectPrimitive.ItemText>
                                    {option.label}
                                </SelectPrimitive.ItemText>
                                <SelectPrimitive.ItemIndicator className='select-indicator'>
                                    <Icon name='tick' />
                                </SelectPrimitive.ItemIndicator>
                            </SelectPrimitive.Item>
                        ))}
                    </SelectPrimitive.Viewport>
                    <SelectPrimitive.ScrollDownButton className='select-scroll'>
                        <Icon name='chevron' />
                    </SelectPrimitive.ScrollDownButton>
                </SelectPrimitive.Content>
            </div>
        </SelectPrimitive.Root>
    );
}
