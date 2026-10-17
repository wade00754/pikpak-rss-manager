import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BackfillPanel } from '../src/components/BackfillPanel.js';
import { Appearance, Preferences } from '../src/components/Preferences.js';
import type { BackfillPlan } from '../src/lib/types.js';

const items: BackfillPlan['items'] = [
    { id: 'one', title: 'Fixture 01', filenames: ['Episode.mkv', 'Notes.txt'] },
    { id: 'two', title: 'Fixture 02', filenames: ['Episode 02.mkv'] },
    {
        id: 'bad',
        title: 'Unavailable fixture',
        filenames: [],
        error: 'Fixture error',
    },
];
const plan = (entries = items) => ({
    token: 'fixture-token',
    items: entries,
    notices: [],
});
const success = async () => undefined;
function panel() {
    return render(
        <Preferences>
            <Appearance toggleLanguage />
            <BackfillPanel
                onClose={vi.fn<() => void>()}
                onSaved={success}
                subscriptionID={1}
            />
        </Preferences>
    );
}

describe('Backfill bulk selection', () => {
    it('selects whole available torrents, tracks partial selection and clears with the keyboard', async () => {
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(Response.json(plan()));
        panel();
        const first = await screen.findByRole('checkbox', {
            name: /Fixture 01/,
        });
        const second = screen.getByRole('checkbox', { name: /Fixture 02/ });
        const unavailable = screen.getByRole('checkbox', {
            name: /Unavailable fixture/,
        });
        const all = screen.getByRole('checkbox', { name: '全選' });
        const download = screen.getByRole('button', { name: '下載所選項目' });
        expect(download).toHaveProperty('disabled', true);
        await userEvent.click(all);
        expect(first).toHaveProperty('checked', true);
        expect(second).toHaveProperty('checked', true);
        expect(unavailable).toHaveProperty('disabled', true);
        expect(unavailable).toHaveProperty('checked', false);
        expect(all).toHaveProperty('checked', true);
        expect(all).toHaveProperty('indeterminate', false);
        await userEvent.click(first);
        expect(all).toHaveProperty('checked', false);
        expect(all).toHaveProperty('indeterminate', true);
        await userEvent.click(first);
        expect(all).toHaveProperty('checked', true);
        all.focus();
        await userEvent.keyboard(' ');
        expect(first).toHaveProperty('checked', false);
        expect(second).toHaveProperty('checked', false);
        expect(all).toHaveProperty('indeterminate', false);
        expect(download).toHaveProperty('disabled', true);
        expect(fetch).toHaveBeenCalledOnce();
        await userEvent.click(
            screen.getByRole('button', { name: '切換為英文' })
        );
        expect(screen.getByRole('checkbox', { name: 'Select all' })).toBe(all);
    });

    it.each([{ entries: [] }, { entries: [items[2]] }])(
        'disables bulk selection for unavailable plans %#',
        async ({ entries }) => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                Response.json(plan(entries))
            );
            panel();
            await waitFor(() => {
                expect(screen.queryByText('正在讀取下載清單…')).toBeNull();
            });
            expect(
                screen.getByRole('checkbox', { name: '全選' })
            ).toHaveProperty('disabled', true);
            expect(
                screen.getByRole('button', { name: '下載所選項目' })
            ).toHaveProperty('disabled', true);
        }
    );

    it('disables bulk selection while loading and resets when reopened', async () => {
        const preview = Promise.withResolvers<Response>();
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockReturnValueOnce(preview.promise);
        const view = panel();
        const all = screen.getByRole('checkbox', { name: '全選' });
        expect(all).toHaveProperty('disabled', true);
        preview.resolve(Response.json(plan()));
        await waitFor(() => {
            expect(all).toHaveProperty('disabled', false);
        });
        await userEvent.click(all);
        view.unmount();
        fetch.mockResolvedValue(Response.json(plan()));
        panel();
        await screen.findByRole('checkbox', { name: /Fixture 01/ });
        expect(screen.getByRole('checkbox', { name: '全選' })).toHaveProperty(
            'checked',
            false
        );
        expect(
            screen.getByRole('button', { name: '下載所選項目' })
        ).toHaveProperty('disabled', true);
    });

    it('confirms separately, freezes the selected torrents and retries the same confirmation', async () => {
        const submission = Promise.withResolvers<Response>();
        const fetch = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(Response.json(plan()))
            .mockReturnValueOnce(submission.promise)
            .mockResolvedValue(
                Response.json({ error: 'Fixture failure' }, { status: 400 })
            );
        const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
        panel();
        await screen.findByRole('checkbox', { name: /Fixture 01/ });
        const all = screen.getByRole('checkbox', { name: '全選' });
        await userEvent.click(all);
        const download = screen.getByRole('button', { name: '下載所選項目' });
        await userEvent.click(download);
        expect(fetch).toHaveBeenCalledOnce();
        expect(all).toHaveProperty('disabled', false);
        confirm.mockReturnValue(true);
        await userEvent.click(download);
        expect(all).toHaveProperty('disabled', true);
        expect(
            screen.getByRole('checkbox', { name: /Fixture 01/ })
        ).toHaveProperty('disabled', true);
        fireEvent.submit(document.querySelector('#backfill-form')!);
        expect(fetch).toHaveBeenCalledTimes(2);
        submission.resolve(
            Response.json({ error: 'Fixture failure' }, { status: 400 })
        );
        await waitFor(() => {
            expect(download).toHaveProperty('disabled', false);
        });
        expect(all).toHaveProperty('disabled', true);
        await userEvent.click(all);
        expect(all).toHaveProperty('checked', true);
        await userEvent.click(download);
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledTimes(3);
        });
        const payloads = fetch.mock.calls
            .slice(1)
            .map((call) => JSON.parse(call[1]?.body as string) as unknown);
        expect(payloads).toEqual([
            { token: 'fixture-token', selected: ['one', 'two'] },
            { token: 'fixture-token', selected: ['one', 'two'] },
        ]);
    });
});
