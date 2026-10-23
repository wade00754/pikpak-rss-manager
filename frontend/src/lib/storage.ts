import { formatBytes } from './jobs.js';
import type { Status } from './types.js';

function storageSize(value?: string): number {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(b|[egkmpt]i?b)?$/i);
    if (!match) {
        return Number.NaN;
    }
    const unit = match.at(2)?.toUpperCase() ?? 'B';
    const power = unit === 'B' ? 0 : 'KMGTPE'.indexOf(unit[0]) + 1;
    return Number(match[1]) * (unit.includes('I') ? 1024 : 1000) ** power;
}

function storageLabel(value = ''): string {
    return /[a-z]/i.test(value) ? value.trim() : formatBytes(value);
}

export function storageSummary(status: Status): {
    capacity: string;
    free: string;
    percent: number;
} | null {
    const used = storageSize(status.storage_used);
    const total = storageSize(status.storage_total);
    if (
        !status.connected ||
        !Number.isFinite(used) ||
        !Number.isFinite(total) ||
        total <= 0
    ) {
        return null;
    }
    return {
        capacity: `${storageLabel(status.storage_used)} / ${storageLabel(status.storage_total)}`,
        free: formatBytes(String(Math.max(0, total - used))),
        percent: Math.min(100, (used / total) * 100),
    };
}
