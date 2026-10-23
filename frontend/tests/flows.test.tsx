import { StrictMode } from 'react';
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/components/App.js';
import { Auth } from '../src/components/Auth.js';
import { BackfillPanel } from '../src/components/BackfillPanel.js';
import { FolderPicker } from '../src/components/FolderPicker.js';
import { Preferences } from '../src/components/Preferences.js';
import { RenamePreview } from '../src/components/RenamePreview.js';
import { Settings } from '../src/components/Settings.js';
import { SubscriptionDialog } from '../src/components/SubscriptionDialog.js';
import { Tasks } from '../src/components/Tasks.js';
import { TokenForm } from '../src/components/TokenForm.js';
import { Workspace } from '../src/components/Workspace.js';
import { api, setCSRF } from '../src/lib/api.js';
import { translate } from '../src/lib/i18n.js';
import { currentFilename } from '../src/lib/jobs.js';
import type { Job, Rule, Subscription } from '../src/lib/types.js';

function response(value: unknown, status = 200): Response {
    return Response.json(value, {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
const requestPath = (input: RequestInfo | URL): string =>
    typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
const taskOrder = () =>
    [...document.querySelectorAll<HTMLElement>('[data-job]')].map(
        (element) => element.dataset.job
    );
const success = async () => undefined;
const chooseOption = async (control: HTMLElement, label: string) => {
    await userEvent.click(control);
    await userEvent.click(screen.getByRole('option', { name: label }));
};
const job = (id: string, state: string): Job => ({
    id,
    state,
    subscription_id: 1,
    title: '使用者.mkv',
    rule: {
        title: '使用者',
        regex: '',
        replacement: '',
        rename_enabled: false,
    },
    destination: '',
    task_id: `cloud-${id}`,
    progress: 0,
    created_at: 1,
    error: '',
});
describe('React flows', () => {
    it('opens existing settings links after loading the workspace', async () => {
        globalThis.history.replaceState(null, '', '#settings');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const path =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
            return response(
                path === '/api/settings/pikpak'
                    ? { connected: true }
                    : path === '/api/settings/app'
                      ? {
                            public_url: 'http://localhost:8080',
                            allow_private_rss: false,
                        }
                      : []
            );
        });
        try {
            render(
                <Preferences>
                    <Workspace onAuthenticated={success} version='fixture' />
                </Preferences>
            );
            expect(
                await screen.findByRole('dialog', { name: '系統設定' })
            ).toBeTruthy();
            expect(
                screen.getByRole('navigation', { name: '設定分類' })
            ).toBeTruthy();
        } finally {
            globalThis.history.replaceState(null, '', '/');
        }
    });
    it('does not close a newer dialog when a dismissed form finishes saving', async () => {
        const pending = Promise.withResolvers<Response>();
        vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
        const close = vi.fn<() => void>();
        const saved = vi.fn(success);
        const view = render(
            <Preferences>
                <SubscriptionDialog
                    manual
                    onClose={close}
                    onSaved={saved}
                    status={{ connected: true }}
                />
            </Preferences>
        );
        fireEvent.change(screen.getByLabelText('下載連結'), {
            target: { value: 'https://public.test/file' },
        });
        fireEvent.submit(document.querySelector('#subscription-form')!);
        view.unmount();
        pending.resolve(response({ ok: true }));
        await waitFor(() => {
            expect(saved).toHaveBeenCalledOnce();
        });
        expect(close).not.toHaveBeenCalled();
    });
    it('honors the server recovery bootstrap without exposing account data', async () => {
        const root = document.createElement('div');
        root.id = 'root';
        root.dataset.page = 'recovery';
        document.body.append(root);
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response({
                initialized: true,
                authenticated: true,
                csrf: 'fixture-csrf',
                version: 'fixture',
            })
        );
        const view = render(
            <Preferences>
                <App />
            </Preferences>,
            { container: root }
        );
        expect(
            await screen.findByRole('heading', { name: '忘記密碼' })
        ).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(1);
        view.unmount();
        root.remove();
    });
    it('aborts pending folder and source requests when their components close', async () => {
        const signals: AbortSignal[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(
            async (_input, options) =>
                await new Promise<Response>((_resolve, reject) => {
                    const signal = options?.signal;
                    if (signal) {
                        signals.push(signal);
                        signal.addEventListener('abort', () => {
                            reject(new DOMException('Cancelled', 'AbortError'));
                        });
                    }
                })
        );
        const folders = render(
            <Preferences>
                <FolderPicker
                    initialID=''
                    onClose={vi.fn<() => void>()}
                    onSelect={vi.fn<() => void>()}
                />
            </Preferences>
        );
        await waitFor(() => {
            expect(signals.length).toBe(1);
        });
        folders.unmount();
        expect(signals[0].aborted).toBe(true);
        const preview = render(
            <Preferences>
                <RenamePreview
                    rule={{
                        title: '',
                        regex: '',
                        replacement: '',
                        rename_enabled: true,
                    }}
                    subscriptionID={0}
                    url='https://public.test/rss'
                />
            </Preferences>
        );
        await waitFor(() => {
            expect(signals).toHaveLength(2);
        });
        preview.unmount();
        expect(signals[1].aborted).toBe(true);
    });
    it('debounces enabled source reads, skips invalid URLs and ignores cancelled responses', async () => {
        vi.useFakeTimers();
        const oldSource = Promise.withResolvers<Response>();
        const signals: AbortSignal[] = [];
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (_input, options) => {
                signals.push(options!.signal!);
                return signals.length === 1
                    ? await oldSource.promise
                    : response({
                          items: [
                              {
                                  kind: 'torrent_file',
                                  title: 'new',
                                  filename: 'new.mkv',
                              },
                          ],
                          notices: [],
                      });
            });
        const view = render(
            <Preferences>
                <SubscriptionDialog
                    onClose={vi.fn<() => void>()}
                    onSaved={success}
                    status={{ connected: true }}
                />
            </Preferences>
        );
        try {
            fireEvent.change(screen.getByLabelText('RSS 連結'), {
                target: { value: 'https://public.test/old' },
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(600);
            });
            expect(fetch).not.toHaveBeenCalled();
            fireEvent.click(screen.getByRole('button', { name: '檔名規則' }));
            fireEvent.click(screen.getByLabelText('重命名檔案'));
            expect(
                screen.getByText(
                    '支援 $1、${name}；$$ 表示字面 $。請保留需要的副檔名。'
                )
            ).toBeTruthy();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(499);
            });
            expect(fetch).not.toHaveBeenCalled();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1);
            });
            expect(fetch).toHaveBeenCalledOnce();
            fireEvent.click(screen.getByRole('button', { name: '訂閱設定' }));
            fireEvent.change(screen.getByLabelText('RSS 連結'), {
                target: { value: 'not-a-url' },
            });
            expect(signals[0].aborted).toBe(true);
            fireEvent.click(screen.getByRole('button', { name: '檔名規則' }));
            expect(
                screen.getByRole('button', { name: '重新整理種子檔名' })
            ).toHaveProperty('disabled', true);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(600);
            });
            expect(fetch).toHaveBeenCalledOnce();
            fireEvent.click(screen.getByRole('button', { name: '訂閱設定' }));
            fireEvent.change(screen.getByLabelText('RSS 連結'), {
                target: { value: 'https://public.test/new' },
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            expect(fetch).toHaveBeenCalledTimes(2);
            await act(async () => {
                oldSource.resolve(
                    response({
                        items: [
                            {
                                kind: 'torrent_file',
                                title: 'old',
                                filename: 'old.mkv',
                            },
                        ],
                        notices: [],
                    })
                );
            });
            fireEvent.click(screen.getByRole('button', { name: '檔名規則' }));
            expect(screen.getByLabelText('種子檔名').textContent).toBe(
                'new.mkv'
            );
            expect(screen.queryByText('old.mkv')).toBeNull();
        } finally {
            view.unmount();
            vi.useRealTimers();
        }
    });
    it('rejects setup mismatch without an API mutation and clears passwords', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        render(
            <Preferences>
                <Auth onAuthenticated={success} page='setup' version='test' />
            </Preferences>
        );
        fireEvent.change(screen.getByLabelText('密碼'), {
            target: { value: 'one' },
        });
        fireEvent.change(screen.getByLabelText('再次輸入密碼'), {
            target: { value: 'two' },
        });
        fireEvent.submit(document.querySelector('#setup-form')!);
        expect(await screen.findByRole('alert')).toHaveProperty(
            'textContent',
            '兩次輸入的密碼不一致'
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(screen.getByLabelText('密碼')).toHaveProperty('value', '');
        const label = document.querySelector('label[for="setup-public-url"]')!;
        expect(label.nextElementSibling?.className).toBe('info-trigger');
        expect(label.parentElement?.nextElementSibling?.tagName).toBe('INPUT');
    });
    it('shares PAT entry, clears failed secrets and makes only Create PAT a link', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response({ error: '請輸入 PikPak PAT' }, 400)
        );
        render(
            <Preferences>
                <TokenForm onboarding onSaved={success} />
            </Preferences>
        );
        fireEvent.change(screen.getByLabelText('個人存取權杖（PAT）'), {
            target: { value: 'fixture-secret' },
        });
        fireEvent.submit(document.querySelector('#token-form')!);
        expect(await screen.findByRole('alert')).toHaveProperty(
            'textContent',
            '請輸入 PikPak PAT'
        );
        expect(screen.getByLabelText('個人存取權杖（PAT）')).toHaveProperty(
            'value',
            ''
        );
        expect(screen.getByRole('link').textContent).toBe('建立 PAT');
    });
    it('recovers with the existing server API and clears all secrets', async () => {
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(response({ ok: true }));
        render(
            <Preferences>
                <Auth
                    onAuthenticated={success}
                    page='recovery'
                    version='test'
                />
            </Preferences>
        );
        for (const [label, value] of [
            ['復原碼', ' fixture-code '],
            ['新密碼', 'x'],
            ['再次輸入新密碼', 'x'],
        ]) {
            fireEvent.change(screen.getByLabelText(label), {
                target: { value },
            });
        }
        fireEvent.submit(document.querySelector('#recovery-form')!);
        expect(await screen.findByText('密碼已重設')).toBeTruthy();
        expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
            code: 'fixture-code',
            new_password: 'x',
            confirm_password: 'x',
        });
        expect(screen.queryByLabelText('復原碼')).toBeNull();
    });
    it('retains unsaved site fields when switching settings categories', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response({
                public_url: 'http://localhost:8080',
                allow_private_feeds: false,
            })
        );
        render(
            <Preferences>
                <Settings
                    onAuthenticated={success}
                    onRefresh={success}
                    status={{ connected: true }}
                />
            </Preferences>
        );
        await waitFor(() => {
            expect(document.querySelector('#settings-public-url')).toBeTruthy();
        });
        await userEvent.click(screen.getByRole('button', { name: '網站設定' }));
        fireEvent.change(screen.getByLabelText('網站網址'), {
            target: { value: 'https://edited.test' },
        });
        await userEvent.click(
            document.querySelector<HTMLButtonElement>('#settings-nav-password')!
        );
        await userEvent.click(screen.getByRole('button', { name: '網站設定' }));
        expect(screen.getByLabelText('網站網址')).toHaveProperty(
            'value',
            'https://edited.test'
        );
    });
    it('shows all tasks grouped by attention, active and completed, and opens details with pointer and keyboard', async () => {
        const onOpen = vi.fn<(id: string) => void>();
        const onClear = vi.fn<() => void>();
        render(
            <Preferences>
                <Tasks
                    busy={false}
                    date={() => '10/12 08:00'}
                    jobs={[
                        { ...job('done', 'complete'), created_at: 400 },
                        { ...job('running', 'queued'), created_at: 500 },
                        { ...job('review', 'needs_review'), created_at: 300 },
                        { ...job('failed', 'failed'), created_at: 100 },
                    ]}
                    onAdd={vi.fn<() => void>()}
                    onClear={onClear}
                    onOpen={onOpen}
                />
            </Preferences>
        );
        expect(taskOrder()).toEqual(['review', 'failed', 'running', 'done']);
        expect(
            [...document.querySelectorAll('.job-group-title')].map(
                (heading) => heading.textContent
            )
        ).toEqual(['需要處理', '進行中', '已完成']);
        expect(
            within(screen.getByRole('region', { name: '已完成' })).getByRole(
                'button',
                { name: '清除已完成任務' }
            )
        ).toBeTruthy();
        expect(screen.queryByRole('table')).toBeNull();
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(
            document.querySelector('.job-info .row-metadata')?.textContent
        ).toBe('使用者.mkv · 10/12 08:00');
        const firstTask = screen.getAllByRole('button', {
            name: '使用者 · 使用者.mkv · 待處理',
        })[0];
        await userEvent.click(firstTask);
        firstTask.focus();
        await userEvent.keyboard('{Enter}');
        await userEvent.keyboard(' ');
        expect(onOpen.mock.calls).toEqual([['review'], ['review'], ['review']]);
        await userEvent.click(
            document.querySelector<HTMLButtonElement>('[data-job="done"]')!
        );
        expect(onOpen).toHaveBeenLastCalledWith('done');
        await userEvent.click(
            screen.getByRole('button', { name: '清除已完成任務' })
        );
        expect(onClear).toHaveBeenCalledOnce();
    });
    it('shows the task empty state only when no tasks remain', () => {
        const props = {
            busy: false,
            date: () => '',
            onAdd: vi.fn<() => void>(),
            onClear: vi.fn<() => void>(),
            onOpen: vi.fn<(id: string) => void>(),
        };
        const { rerender } = render(
            <Preferences>
                <Tasks {...props} jobs={[job('running', 'queued')]} />
            </Preferences>
        );
        expect(taskOrder()).toEqual(['running']);
        rerender(
            <Preferences>
                <Tasks {...props} jobs={[]} />
            </Preferences>
        );
        expect(screen.getByText('尚無任務')).toBeTruthy();
    });
    it('opens a status-icon task card into full status and download progress', async () => {
        const downloading = {
            ...job('downloading', 'downloading'),
            progress: 43,
            destination: 'Series',
        };
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const path = requestPath(input);
            if (path === '/api/jobs/downloading') {
                return response({ job: downloading, files: [] });
            }
            if (path === '/api/jobs') {
                return response([downloading]);
            }
            if (path === '/api/subscriptions' || path === '/api/events') {
                return response([]);
            }
            return response({ connected: true });
        });
        render(
            <Preferences>
                <Workspace onAuthenticated={success} version='test' />
            </Preferences>
        );
        const [card] = await screen.findAllByRole('button', {
            name: '使用者 · 使用者.mkv · 雲端下載中',
        });
        expect(screen.getByText('43%')).toBeTruthy();
        expect(screen.queryByText('雲端下載中')).toBeNull();
        await userEvent.click(card);
        const details = await screen.findByRole('dialog');
        await within(details).findByText('43%');
        expect(screen.getByText('雲端下載中')).toBeTruthy();
        expect(screen.getByText('Series', { exact: false })).toBeTruthy();
    });
    it('toggles tracking without opening settings and retains subscription rules on failed updates', async () => {
        let sub: Subscription = {
            id: 7,
            name: '測試訂閱',
            rss_url: 'https://public.test/rss',
            destination: 'Series',
            destination_id: 'folder-7',
            destination_account_ref: 'account-ref',
            enabled: false,
            interval_minutes: 30,
            initialized: true,
            last_checked: 1,
            next_check: 2,
            last_error: '',
            rename_enabled: false,
            regex: 'original',
            replacement: 'requested',
        };
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input, options) => {
                const path = requestPath(input);
                if (options?.method === 'PUT') {
                    const payload = JSON.parse(
                        options.body as string
                    ) as Subscription;
                    if (!payload.enabled) {
                        return response({ error: 'fixture save failed' }, 400);
                    }
                    sub = { ...sub, ...payload };
                    return response(sub);
                }
                if (path === '/api/subscriptions') {
                    return response([sub]);
                }
                if (path === '/api/jobs' || path === '/api/events') {
                    return response([]);
                }
                return response({ connected: true });
            });
        render(
            <Preferences>
                <Workspace onAuthenticated={success} version='test' />
            </Preferences>
        );
        await userEvent.click(
            await screen.findByRole('button', { name: '繼續追蹤 測試訂閱' })
        );
        const pause = await screen.findByRole('button', {
            name: '暫停追蹤 測試訂閱',
        });
        expect(document.querySelector('dialog')).toBeNull();
        const mutation = fetch.mock.calls.find(
            ([, options]) => options?.method === 'PUT'
        )!;
        expect(JSON.parse(mutation[1]!.body as string)).toEqual({
            name: '測試訂閱',
            rss_url: 'https://public.test/rss',
            destination: 'Series',
            destination_id: 'folder-7',
            destination_account_ref: 'account-ref',
            interval_minutes: 30,
            rename_enabled: false,
            regex: 'original',
            replacement: 'requested',
            enabled: true,
        });
        await userEvent.click(pause);
        await screen.findByText('fixture save failed');
        expect(
            screen.getByRole('button', { name: '暫停追蹤 測試訂閱' })
        ).toBeTruthy();
        expect(screen.queryByRole('searchbox')).toBeNull();
        await userEvent.click(
            document.querySelector<HTMLButtonElement>('[data-edit="7"]')!
        );
        expect(screen.getByRole('dialog', { name: '測試訂閱' })).toBeTruthy();
        expect(screen.getByRole('button', { name: '檔名規則' })).toBeTruthy();
    });
    it('preserves subscription drafts across naming and management, keeps backfill inline and saves a paused subscription as paused', async () => {
        const sub: Subscription = {
            id: 7,
            name: '測試訂閱',
            rss_url: 'https://public.test/rss',
            destination: '',
            enabled: false,
            interval_minutes: 30,
            initialized: true,
            last_checked: 1,
            next_check: 2,
            last_error: '',
            rename_enabled: false,
            regex: '',
            replacement: '',
        };
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input) =>
                response(
                    requestPath(input).endsWith('/backfill/preview')
                        ? { token: 'fixture', items: [], notices: [] }
                        : { ok: true }
                )
            );
        const saved = vi.fn(success);
        render(
            <Preferences>
                <SubscriptionDialog
                    onClose={vi.fn<() => void>()}
                    onSaved={saved}
                    status={{ connected: true }}
                    subscription={sub}
                />
            </Preferences>
        );
        expect(screen.queryByLabelText('啟用自動追蹤')).toBeNull();
        await userEvent.clear(screen.getByLabelText('訂閱名稱'));
        await userEvent.type(screen.getByLabelText('訂閱名稱'), '草稿名稱');
        await userEvent.click(screen.getByRole('button', { name: '檔名規則' }));
        expect(screen.getByLabelText('重命名檔案')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: '管理訂閱' }));
        await userEvent.click(
            screen.getByRole('button', { name: '檢查新的發布' })
        );
        await screen.findByText('訂閱檢查完成');
        expect(
            fetch.mock.calls.some(([path]) =>
                requestPath(path).endsWith('/7/check')
            )
        ).toBe(true);
        await userEvent.click(screen.getByRole('button', { name: '補抓' }));
        await screen.findByText('RSS 中沒有可下載的項目');
        expect(document.querySelector('form form')).toBeNull();
        expect(document.querySelectorAll('dialog')).toHaveLength(1);
        await userEvent.click(screen.getByRole('button', { name: '取消' }));
        await userEvent.click(screen.getByRole('button', { name: '訂閱設定' }));
        expect(screen.getByLabelText('訂閱名稱')).toHaveProperty(
            'value',
            '草稿名稱'
        );
        await userEvent.click(screen.getByRole('button', { name: '儲存訂閱' }));
        await waitFor(() => {
            expect(saved).toHaveBeenCalledTimes(2);
        });
        const mutation = fetch.mock.calls.find(([path]) =>
            requestPath(path).endsWith('/7')
        )!;
        expect(JSON.parse(mutation[1]!.body as string)).toMatchObject({
            name: '草稿名稱',
            enabled: false,
        });
    });
    it('confirms subscription deletion and keeps settings open when deletion fails', async () => {
        const sub: Subscription = {
            id: 7,
            name: '測試訂閱',
            rss_url: 'https://public.test/rss',
            destination: '',
            enabled: false,
            interval_minutes: 30,
            initialized: true,
            last_checked: 1,
            next_check: 2,
            last_error: '',
            rename_enabled: false,
            regex: '',
            replacement: '',
        };
        const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                response({ error: 'fixture deletion failed' }, 400)
            );
        const close = vi.fn<() => void>();
        render(
            <Preferences>
                <SubscriptionDialog
                    onClose={close}
                    onSaved={success}
                    status={{ connected: true }}
                    subscription={sub}
                />
            </Preferences>
        );
        await userEvent.click(screen.getByRole('button', { name: '管理訂閱' }));
        await userEvent.click(screen.getByRole('button', { name: '刪除訂閱' }));
        expect(fetch).not.toHaveBeenCalled();
        confirm.mockReturnValue(true);
        await userEvent.click(screen.getByRole('button', { name: '刪除訂閱' }));
        await screen.findByText('fixture deletion failed');
        expect(close).not.toHaveBeenCalled();
        expect(fetch.mock.calls[0][1]).toHaveProperty('method', 'DELETE');
    });
    it('reveals and focuses invalid fields in another subscription settings section before saving', async () => {
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(response({ ok: true }));
        render(
            <Preferences>
                <SubscriptionDialog
                    onClose={vi.fn<() => void>()}
                    onSaved={success}
                    status={{ connected: true }}
                />
            </Preferences>
        );
        fireEvent.change(screen.getByLabelText('檢查間隔（分鐘）'), {
            target: { value: '30' },
        });
        await userEvent.click(screen.getByRole('button', { name: '檔名規則' }));
        await userEvent.click(screen.getByRole('button', { name: '儲存訂閱' }));
        await waitFor(() => {
            expect(document.activeElement).toBe(
                screen.getByLabelText('訂閱名稱')
            );
        });
        expect(
            document.querySelector('#subscription-settings-general')
        ).toHaveProperty('hidden', false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('submits manual downloads to root without subscription or rename fields', async () => {
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(response({ ok: true }));
        const saved = vi.fn(success);
        render(
            <Preferences>
                <SubscriptionDialog
                    manual
                    onClose={vi.fn<() => void>()}
                    onSaved={saved}
                    status={{ connected: true }}
                />
            </Preferences>
        );
        fireEvent.change(screen.getByLabelText('下載連結'), {
            target: { value: 'magnet:?xt=urn:btih:fixture' },
        });
        fireEvent.submit(document.querySelector('#subscription-form')!);
        await waitFor(() => {
            expect(saved).toHaveBeenCalled();
        });
        expect(fetch.mock.calls[0][0]).toBe('/api/jobs');
        expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
            url: 'magnet:?xt=urn:btih:fixture',
            destination: '',
            destination_id: '',
            destination_account_ref: '',
        });
        expect(screen.queryByLabelText('重命名檔案')).toBeNull();
    });
    it('selects root with its account reference and aborts stale folder reads', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            response({
                current: { id: '', name: '根目錄', path: '' },
                breadcrumbs: [],
                folders: [],
                account_ref: 'opaque-account',
            })
        );
        const selected = vi.fn<() => void>();
        const view = render(
            <Preferences>
                <FolderPicker
                    initialID=''
                    onClose={vi.fn<() => void>()}
                    onSelect={selected}
                />
            </Preferences>
        );
        await userEvent.click(
            await screen.findByRole('button', { name: '使用根目錄' })
        );
        expect(selected).toHaveBeenCalledWith({
            path: '',
            id: '',
            account: 'opaque-account',
        });
        view.unmount();
    });
    it('keeps backfill selection and confirmation token for an explicit idempotent retry', async () => {
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input) =>
                (typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url
                ).endsWith('/preview')
                    ? response({
                          token: 'confirmation-token',
                          items: [
                              {
                                  id: 'torrent-1',
                                  title: '公開測試',
                                  filenames: ['raw.mkv'],
                              },
                          ],
                          notices: [],
                      })
                    : response({ error: '操作未完成，請稍後再試' }, 400)
            );
        vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
        render(
            <Preferences>
                <BackfillPanel
                    onClose={vi.fn<() => void>()}
                    onSaved={success}
                    subscriptionID={1}
                />
            </Preferences>
        );
        await userEvent.click(
            await screen.findByRole('checkbox', { name: /^公開測試/ })
        );
        await userEvent.click(
            screen.getByRole('button', { name: '下載所選項目' })
        );
        await waitFor(() => {
            expect(
                screen.getByRole('button', { name: '下載所選項目' })
            ).toHaveProperty('disabled', false);
        });
        await userEvent.click(
            screen.getByRole('button', { name: '下載所選項目' })
        );
        await waitFor(() => {
            expect(fetch.mock.calls).toHaveLength(3);
        });
        const payloads = fetch.mock.calls
            .slice(1)
            .map((call) => JSON.parse(call[1]?.body as string) as unknown);
        expect(payloads).toEqual([
            { token: 'confirmation-token', selected: ['torrent-1'] },
            { token: 'confirmation-token', selected: ['torrent-1'] },
        ]);
    });
    it('automatically loads filenames once in Strict Mode and preserves selection through refresh and retry', async () => {
        let reads = 0;
        const items = [
            { kind: 'title', title: 'ignore', filename: 'guessed.mkv' },
            { kind: 'torrent_file', title: 'raw', filename: 'raw[01].mkv' },
            { kind: 'torrent_file', title: 'raw', filename: 'raw[01].mkv' },
            { kind: 'torrent_file', title: 'raw', filename: 'raw[02].mkv' },
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
                if (path.endsWith('/samples')) {
                    reads++;
                    return reads === 2
                        ? response({ error: '來源回傳非成功狀態' }, 400)
                        : response({
                              items: reads > 2 ? items.toReversed() : items,
                              notices: [],
                          });
                }
                const body = JSON.parse(options?.body as string) as {
                    filename: string;
                    rule: Rule;
                };
                return response({
                    name: body.filename.replace(
                        new RegExp(body.rule.regex),
                        body.rule.replacement
                    ),
                });
            });
        const rule: Rule = {
            title: '',
            regex: String.raw`\[(\d+)\]`,
            replacement: 'S01E$1',
            rename_enabled: true,
        };
        const view = render(
            <StrictMode>
                <Preferences>
                    <RenamePreview
                        rule={rule}
                        subscriptionID={1}
                        url='https://public.test/rss'
                    />
                </Preferences>
            </StrictMode>
        );
        await userEvent.click(await screen.findByLabelText('種子檔名'));
        const options = await screen.findAllByRole('option');
        expect(options.map((option) => option.textContent)).toEqual([
            'raw[01].mkv',
            'raw[02].mkv',
        ]);
        await userEvent.keyboard('{Escape}');
        expect(await screen.findByText('rawS01E01.mkv')).toBeTruthy();
        expect(reads).toBe(1);
        await chooseOption(screen.getByLabelText('種子檔名'), 'raw[02].mkv');
        expect(await screen.findByText('rawS01E02.mkv')).toBeTruthy();
        await userEvent.click(
            screen.getByRole('button', { name: '重新整理種子檔名' })
        );
        expect(await screen.findByText('來源回傳非成功狀態')).toBeTruthy();
        expect(screen.getByLabelText('種子檔名').textContent).toBe(
            'raw[02].mkv'
        );
        await userEvent.click(
            screen.getByRole('button', { name: '重新整理種子檔名' })
        );
        await waitFor(() => {
            expect(screen.getByLabelText('種子檔名').textContent).toBe(
                'raw[02].mkv'
            );
        });
        expect(screen.getByText('rawS01E02.mkv')).toBeTruthy();
        view.rerender(
            <StrictMode>
                <Preferences>
                    <RenamePreview
                        rule={{ ...rule, replacement: 'S02E$1' }}
                        subscriptionID={1}
                        url='https://public.test/rss'
                    />
                </Preferences>
            </StrictMode>
        );
        expect(await screen.findByText('rawS02E02.mkv')).toBeTruthy();
        expect(reads).toBe(3);
        expect(
            fetch.mock.calls.filter((call) => call[0] === '/api/rules/preview')
        ).toHaveLength(3);
        view.unmount();
    });
    it('preserves actual filenames and translates application copy with literal regex references', () => {
        expect(
            currentFilename({
                actual_name: 'PikPak (1).mkv',
                original_name: 'raw.mkv',
                target_name: 'requested.mkv',
            })
        ).toBe('PikPak (1).mkv');
        expect(translate('每 10 分鐘', 'en')).toBe('Every 10 min');
        expect(translate('使用者.mkv', 'en')).toBe('使用者.mkv');
        expect(
            translate(
                '支援 $1、${name}；$$ 表示字面 $。請保留需要的副檔名。',
                'en'
            )
        ).toContain('${name}');
    });
    it('sends session CSRF and expires authenticated UI on an unauthorized response', async () => {
        setCSRF('fixture-csrf');
        const expired = vi.fn<() => void>();
        globalThis.addEventListener('session-expired', expired);
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(response({ error: '請先登入' }, 401));
        await expect(api('/api/subscriptions')).rejects.toThrow('請先登入');
        expect(fetch.mock.calls[0][1]?.headers).toHaveProperty(
            'X-CSRF-Token',
            'fixture-csrf'
        );
        expect(expired).toHaveBeenCalledOnce();
        globalThis.removeEventListener('session-expired', expired);
    });
});
