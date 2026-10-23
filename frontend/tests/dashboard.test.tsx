import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Preferences } from '../src/components/Preferences.js';
import { Tasks } from '../src/components/Tasks.js';
import { Workspace } from '../src/components/Workspace.js';
import { WorkspaceSummary } from '../src/components/WorkspaceSummary.js';
import type { Job, Subscription } from '../src/lib/types.js';

const subscription = (
    id: number,
    due: number,
    enabled = true
): Subscription => ({
    id,
    name: `Feed ${id}`,
    rss_url: 'https://fixture.test/rss',
    destination: '',
    enabled,
    interval_minutes: 10,
    initialized: true,
    last_checked: due - 600,
    next_check: due,
    last_error: '',
    regex: '',
    replacement: '',
    rename_enabled: false,
});
const job = (id: string, state: string, progress: number): Job => ({
    id,
    state,
    progress,
    subscription_id: 1,
    title: 'fixture.mkv',
    rule: {
        title: 'Fixture',
        regex: '',
        replacement: '',
        rename_enabled: false,
    },
    destination: '',
    task_id: `cloud-${id}`,
    created_at: 1,
    error: '',
});
const taskProps = {
    busy: false,
    date: () => '12:00',
    onAdd: vi.fn<() => void>(),
    onClear: vi.fn<() => void>(),
    onOpen: vi.fn<() => void>(),
};

describe('Dashboard telemetry', () => {
    it('checks the latest enabled feeds once, shows pending feedback and refreshes the schedule', async () => {
        globalThis.history.replaceState(null, '', '#overview');
        const now = Math.floor(Date.now() / 1000);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
        const subscriptions = [
            subscription(1, now + 60),
            subscription(2, now + 180),
            subscription(3, now, false),
        ];
        const pending = Promise.withResolvers<Response>();
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input, options) => {
                const path =
                    typeof input === 'string'
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (options?.method === 'POST') {
                    return await pending.promise;
                }
                return Response.json(
                    path === '/api/subscriptions'
                        ? subscriptions
                        : path === '/api/jobs' || path === '/api/events'
                          ? []
                          : { connected: true }
                );
            });
        render(
            <Preferences>
                <Workspace
                    onAuthenticated={async () => undefined}
                    version='test'
                />
            </Preferences>
        );
        const button = await screen.findByRole('button', {
            name: '立即檢查 RSS',
        });
        // Simulate a subscription paused in another client after the initial snapshot.
        subscriptions[0].enabled = false;
        await userEvent.click(button);
        await screen.findByText('正在檢查…');
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button).toHaveProperty('disabled', true);
        expect(
            button.querySelector('.lucide-refresh-cw.is-loading')
        ).toBeTruthy();
        fireEvent.click(button);
        const writes = () =>
            fetch.mock.calls.filter(
                ([, options]) => options?.method === 'POST'
            );
        await waitFor(() => {
            expect(writes()).toHaveLength(1);
        });
        expect(writes()[0][0]).toBe('/api/subscriptions/2/check');
        expect(JSON.parse(writes()[0][1]?.body as string)).toEqual({});
        clock.mockReturnValue((now + 5) * 1000);
        subscriptions[1].next_check = now + 5 + 600;
        await act(async () => {
            pending.resolve(Response.json({ ok: true }));
        });
        await screen.findByText('RSS 檢查完成');
        expect(button).toHaveProperty('disabled', false);
        expect(button.getAttribute('aria-busy')).toBe('false');
        await waitFor(() => {
            expect(
                screen.getByRole('region', { name: '下次 RSS 檢查' })
                    .textContent
            ).toBe('下次檢查 · 10 分鐘後');
        });
        expect(writes()).toHaveLength(1);
        clock.mockRestore();
    });
    it('continues checking other feeds after an error and refreshes data without retrying the failed request', async () => {
        globalThis.history.replaceState(null, '', '#overview');
        const now = Math.floor(Date.now() / 1000);
        const subscriptions = [
            subscription(1, now + 60),
            subscription(2, now + 180),
        ];
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input, options) => {
                const path =
                    typeof input === 'string'
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (options?.method === 'POST') {
                    if (path === '/api/subscriptions/1/check') {
                        return Response.json(
                            { error: '來源回傳非成功狀態' },
                            { status: 500 }
                        );
                    }
                    subscriptions[1].next_check = now + 600;
                    return Response.json({ ok: true });
                }
                return Response.json(
                    path === '/api/subscriptions'
                        ? subscriptions
                        : path === '/api/jobs' || path === '/api/events'
                          ? []
                          : { connected: true }
                );
            });
        render(
            <Preferences>
                <Workspace
                    onAuthenticated={async () => undefined}
                    version='test'
                />
            </Preferences>
        );
        const button = await screen.findByRole('button', {
            name: '立即檢查 RSS',
        });
        await userEvent.click(button);
        const feedback = await screen.findByRole('status');
        expect(feedback.textContent).toBe('來源回傳非成功狀態');
        expect(
            fetch.mock.calls
                .filter(([, options]) => options?.method === 'POST')
                .map(([input]) => input)
        ).toEqual(['/api/subscriptions/1/check', '/api/subscriptions/2/check']);
        expect(
            fetch.mock.calls.filter(([input]) => input === '/api/subscriptions')
        ).toHaveLength(3);
        expect(button).toHaveProperty('disabled', false);
    });
    it('shows raw bytes and official formatted storage, without presenting missing data as zero usage', () => {
        const subscriptions: Subscription[] = [];
        const { rerender } = render(
            <Preferences>
                <WorkspaceSummary
                    status={{
                        connected: true,
                        storage_used: '250',
                        storage_total: '1000',
                    }}
                    subscriptions={subscriptions}
                />
            </Preferences>
        );
        const meter = screen.getByRole('meter', { name: 'PikPak 空間' });
        expect(meter.getAttribute('aria-valuenow')).toBe('25');
        expect(meter.getAttribute('aria-valuetext')).toContain('剩餘 750 B');
        expect(screen.getByText('250 B / 1000 B')).toBeTruthy();
        rerender(
            <Preferences>
                <WorkspaceSummary
                    status={{
                        connected: true,
                        storage_used: '2.50 TB',
                        storage_total: '10.00 TB',
                    }}
                    subscriptions={subscriptions}
                />
            </Preferences>
        );
        expect(screen.getByText('2.50 TB / 10.00 TB')).toBeTruthy();
        expect(meter.getAttribute('aria-valuenow')).toBe('25');
        rerender(
            <Preferences>
                <WorkspaceSummary
                    status={{
                        connected: true,
                        storage_used: '512 GiB',
                        storage_total: '1 TiB',
                    }}
                    subscriptions={subscriptions}
                />
            </Preferences>
        );
        expect(meter.getAttribute('aria-valuenow')).toBe('50');
        rerender(
            <Preferences>
                <WorkspaceSummary
                    status={{ connected: true }}
                    subscriptions={subscriptions}
                />
            </Preferences>
        );
        expect(screen.queryByRole('meter', { name: 'PikPak 空間' })).toBeNull();
        expect(screen.getByText('空間資料暫不可用')).toBeTruthy();
        rerender(
            <Preferences>
                <WorkspaceSummary
                    status={{
                        connected: true,
                        storage_used: '1100',
                        storage_total: '1000',
                    }}
                    subscriptions={subscriptions}
                />
            </Preferences>
        );
        expect(
            screen
                .getByRole('meter', { name: 'PikPak 空間' })
                .getAttribute('aria-valuenow')
        ).toBe('100');
        expect(
            screen.getByRole('meter', { name: 'PikPak 空間' }).className
        ).toContain('is-warning');
    });
    it('counts down to the earliest enabled feed once globally and distinguishes due from paused', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-12T14:00:00+08:00'));
        try {
            const now = Date.now() / 1000;
            const subscriptions = [
                subscription(1, now + 180),
                subscription(2, now + 30),
                subscription(3, now, false),
            ];
            const { rerender } = render(
                <Preferences>
                    <WorkspaceSummary
                        status={{ connected: true }}
                        subscriptions={subscriptions}
                    />
                </Preferences>
            );
            expect(
                screen.getAllByRole('region', { name: '下次 RSS 檢查' })
            ).toHaveLength(1);
            expect(
                screen.getByRole('region', { name: '下次 RSS 檢查' })
                    .textContent
            ).toBe('下次檢查 · 30 秒後');
            await act(() => vi.advanceTimersByTime(30_000));
            expect(
                screen.getByRole('region', { name: '下次 RSS 檢查' })
                    .textContent
            ).toBe('下次檢查 · 即將檢查');
            rerender(
                <Preferences>
                    <WorkspaceSummary
                        status={{ connected: true, paused: 'quota' }}
                        subscriptions={subscriptions}
                    />
                </Preferences>
            );
            expect(
                screen.getByRole('region', { name: '下次 RSS 檢查' })
                    .textContent
            ).toBe('下次檢查 · RSS 已暫停');
            expect(
                screen.queryByRole('meter', { name: 'RSS 檢查週期' })
            ).toBeNull();
            rerender(
                <Preferences>
                    <WorkspaceSummary
                        status={{ connected: true }}
                        subscriptions={[subscription(3, now, false)]}
                    />
                </Preferences>
            );
            expect(
                screen.getByRole('region', { name: '下次 RSS 檢查' })
                    .textContent
            ).toBe('下次檢查 · 尚無啟用訂閱');
        } finally {
            vi.useRealTimers();
        }
    });
    it('shows bounded download progress only on downloading tasks and retains row detail access', () => {
        const { rerender } = render(
            <Preferences>
                <Tasks
                    {...taskProps}
                    jobs={[
                        job('running', 'downloading', 43),
                        job('queued', 'queued', 0),
                        job('done', 'complete', 100),
                    ]}
                />
            </Preferences>
        );
        expect(screen.getAllByRole('progressbar')).toHaveLength(1);
        expect(
            screen.getByRole('progressbar').getAttribute('aria-valuenow')
        ).toBe('43');
        expect(screen.getByText('43%')).toBeTruthy();
        expect(document.querySelectorAll('[data-job]')).toHaveLength(3);
        expect(document.querySelector('.workspace-row-menu')).toBeNull();
        rerender(
            <Preferences>
                <Tasks
                    {...taskProps}
                    jobs={[job('running', 'downloading', 120)]}
                />
            </Preferences>
        );
        expect(
            screen.getByRole('progressbar').getAttribute('aria-valuenow')
        ).toBe('100');
        rerender(
            <Preferences>
                <Tasks
                    {...taskProps}
                    jobs={[job('running', 'downloading', Number.NaN)]}
                />
            </Preferences>
        );
        expect(screen.queryByRole('progressbar')).toBeNull();
    });
});
