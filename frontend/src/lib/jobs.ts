import type { IconName } from '../components/Icon.js';
import type { Job } from './types.js';

export const reviewStates = [
    'needs_review',
    'submission_unknown',
    'failed',
    'paused_auth',
    'paused_quota',
    'paused_account',
];
export const jobLabels: Record<string, string> = {
    queued: '等待處理',
    submitting: '正在提交',
    submission_unknown: '提交待核對',
    downloading: '雲端下載中',
    organizing: '正在整理',
    complete: '已完成',
    needs_review: '待處理',
    failed: '下載失敗',
    paused_auth: '授權暫停',
    paused_quota: '配額暫停',
    paused_account: '帳號暫停',
};
export function jobColor(state: string): 'green' | 'warning' | 'purple' {
    return state === 'complete'
        ? 'green'
        : reviewStates.includes(state)
          ? 'warning'
          : 'purple';
}
export function jobIcon(state: string): IconName {
    return state === 'complete'
        ? 'check'
        : reviewStates.includes(state)
          ? 'alert'
          : 'backfill';
}
export const jobGroups = [
    { color: 'warning', label: '需要處理' },
    { color: 'purple', label: '進行中' },
    { color: 'green', label: '已完成' },
] as const;
export function sortJobs(jobs: Job[]): Job[] {
    return jobs.toSorted(
        (a, b) =>
            jobGroups.findIndex((group) => group.color === jobColor(a.state)) -
                jobGroups.findIndex(
                    (group) => group.color === jobColor(b.state)
                ) || b.created_at - a.created_at
    );
}
export function currentFilename(file: {
    actual_name?: string;
    original_name: string;
    target_name: string;
}): string {
    return file.actual_name || file.original_name || file.target_name;
}
export function formatBytes(value?: string): string {
    let n = Number(value || 0);
    if (!Number.isFinite(n)) {
        return '—';
    }
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (n >= 1024 && i < 4) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
