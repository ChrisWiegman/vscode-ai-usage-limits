import * as vscode from 'vscode';
import { ProviderStatus, UsagePeriod } from './types';

const DOLLAR = '$';
const CLAUDE_ICON = '✳';
const CODEX_ICON = '◎';

export class StatusBarManager implements vscode.Disposable {
  private readonly claudeItem: vscode.StatusBarItem;
  private readonly openaiItem: vscode.StatusBarItem;
  private readonly errorCommand: string;
  private readonly claudeCommand: string;
  private readonly openaiCommand: string;
  private lastRefreshed: Date | undefined;
  private nextRefreshAt: Date | undefined;

  constructor(errorCommand: string, claudeCommand: string, openaiCommand: string) {
    this.errorCommand = errorCommand;
    this.claudeCommand = claudeCommand;
    this.openaiCommand = openaiCommand;
    this.claudeItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.openaiItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
  }

  setRefreshInfo(last: Date, next: Date): void {
    this.lastRefreshed = last;
    this.nextRefreshAt = next;
  }

  updateClaude(status: ProviderStatus): void {
    this.updateItem(this.claudeItem, 'Claude', CLAUDE_ICON, status, this.claudeCommand);
  }

  updateOpenAI(status: ProviderStatus): void {
    this.updateItem(this.openaiItem, 'Codex', CODEX_ICON, status, this.openaiCommand);
  }

  private updateItem(
    item: vscode.StatusBarItem,
    label: string,
    icon: string,
    status: ProviderStatus,
    defaultCommand: string
  ): void {
    if (!status.available) {
      item.hide();
      return;
    }

    item.text = this.buildText(icon, status);
    item.tooltip = this.buildTooltip(label, status);
    item.command = status.error ? this.errorCommand : defaultCommand;
    item.show();
  }

  private buildText(icon: string, status: ProviderStatus): string {
    if (!status.authenticated) {
      return `${icon} sign in`;
    }
    if (status.error) {
      return `${icon} error`;
    }
    if (!status.budget) {
      return `${icon} ...`;
    }
    if (!hasUsableBudget(status)) {
      return `${icon} unavailable`;
    }

    const parts: string[] = [icon];

    if (status.budget.fiveHour !== null) {
      parts.push(`5h:${this.formatCompact(status.budget.fiveHour)}`);
    }
    if (status.budget.oneWeek !== null) {
      parts.push(`7d:${this.formatCompact(status.budget.oneWeek)}`);
    }

    return parts.join(' ');
  }

  private buildTooltip(label: string, status: ProviderStatus): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;

    if (!status.authenticated) {
      md.appendMarkdown(`**${label}**: Please sign in via the companion extension.`);
      return md;
    }
    if (status.error) {
      md.appendMarkdown(`**${label} error:** ${escapeMarkdown(status.error)}`);
      return md;
    }
    if (!status.budget) {
      md.appendMarkdown(`**${label}**: Fetching usage…`);
      return md;
    }
    if (!hasUsableBudget(status)) {
      md.appendMarkdown(`**${label}**: Usage data is currently unavailable.\n\n`);
      md.appendMarkdown(formatRefreshInfo(this.lastRefreshed, this.nextRefreshAt));
      return md;
    }

    md.appendMarkdown(`### ${label} Usage\n\n`);

    if (status.budget.fiveHour !== null) {
      const value = this.formatDetailed(status.budget.fiveHour);
      const reset = formatResetTime(status.budget.fiveHour.resetsAt);
      md.appendMarkdown(`**Last 5 hours:** ${value}\n\n${reset}`);
    } else {
      md.appendMarkdown(`**Last 5 hours:** unavailable\n\n`);
    }

    if (status.budget.oneWeek !== null) {
      const value = this.formatDetailed(status.budget.oneWeek);
      const reset = formatResetTime(status.budget.oneWeek.resetsAt);
      md.appendMarkdown(`**Last 7 days:** ${value}\n\n${reset}`);
    } else {
      md.appendMarkdown(`**Last 7 days:** unavailable\n\n`);
    }

    md.appendMarkdown(formatRefreshInfo(this.lastRefreshed, this.nextRefreshAt));

    return md;
  }

  private formatCompact(period: UsagePeriod): string {
    if (period.unit === 'percent') {
      return `${period.used.toFixed(0)}%`;
    }
    return `${DOLLAR}${period.used.toFixed(2)}`;
  }

  private formatDetailed(period: UsagePeriod): string {
    if (period.unit === 'percent') {
      const limit = period.limit !== null ? `/${period.limit.toFixed(0)}%` : '';
      return `${period.used.toFixed(1)}%${limit}`;
    }
    const limit = period.limit !== null ? `/${DOLLAR}${period.limit.toFixed(2)}` : '';
    return `${DOLLAR}${period.used.toFixed(4)}${limit}`;
  }

  dispose(): void {
    this.claudeItem.dispose();
    this.openaiItem.dispose();
  }
}

function formatRefreshInfo(last: Date | undefined, next: Date | undefined): string {
  if (!last) return '';
  const now = Date.now();

  const agoMs = now - last.getTime();
  const agoMin = Math.floor(agoMs / 60_000);
  const agoText = agoMin < 1 ? 'just now' : `${agoMin}m ago`;

  if (!next) return `*Updated: ${agoText}*\n\n`;

  const inMs = next.getTime() - now;
  const inMin = Math.max(0, Math.round(inMs / 60_000));
  const nextText = inMin < 1 ? 'soon' : `in ${inMin}m`;

  return `*Updated: ${agoText} · Next refresh: ${nextText}*\n\n`;
}

function hasUsableBudget(status: ProviderStatus): boolean {
  return Boolean(status.budget && (status.budget.fiveHour !== null || status.budget.oneWeek !== null));
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatResetTime(resetsAt: Date | undefined): string {
  if (!resetsAt) return '';

  const now = Date.now();
  const diff = resetsAt.getTime() - now;

  let relative: string;
  if (diff <= 0) {
    relative = 'soon';
  } else {
    const totalMinutes = Math.round(diff / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) {
      relative = `in ${days}d ${hours}h`;
    } else if (hours > 0) {
      relative = `in ${hours}h ${minutes}m`;
    } else {
      relative = `in ${minutes}m`;
    }
  }

  const month = MONTHS[resetsAt.getMonth()];
  const day = resetsAt.getDate();
  const h = resetsAt.getHours();
  const m = resetsAt.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  const absolute = `${month} ${day} at ${hour12}:${m} ${ampm}`;

  return `**Resets:** ${absolute} (${relative})\n\n`;
}
