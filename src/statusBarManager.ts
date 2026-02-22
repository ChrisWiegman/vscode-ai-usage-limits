import * as vscode from 'vscode';
import { ProviderStatus, UsagePeriod } from './types';

const DOLLAR = '$';

export class StatusBarManager implements vscode.Disposable {
  private readonly claudeItem: vscode.StatusBarItem;
  private readonly openaiItem: vscode.StatusBarItem;
  private readonly errorCommand: string;

  constructor(errorCommand: string) {
    this.errorCommand = errorCommand;
    this.claudeItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.openaiItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
  }

  updateClaude(status: ProviderStatus): void {
    this.updateItem(this.claudeItem, 'Claude', status);
  }

  updateOpenAI(status: ProviderStatus): void {
    this.updateItem(this.openaiItem, 'Codex', status);
  }

  private updateItem(
    item: vscode.StatusBarItem,
    label: string,
    status: ProviderStatus
  ): void {
    if (!status.available) {
      item.hide();
      return;
    }

    item.text = this.buildText(label, status);
    item.tooltip = this.buildTooltip(label, status);
    item.command = status.error ? this.errorCommand : undefined;
    item.show();
  }

  private buildText(label: string, status: ProviderStatus): string {
    if (!status.authenticated) {
      return `$(lock) ${label}: sign in`;
    }
    if (status.error) {
      return `$(warning) ${label}: error`;
    }
    if (!status.budget) {
      return `$(sync~spin) ${label}`;
    }

    const parts: string[] = [`$(pulse) ${label}`];

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

    md.appendMarkdown(`### ${label} Usage\n\n`);

    if (status.budget.fiveHour !== null) {
      const value = this.formatDetailed(status.budget.fiveHour);
      md.appendMarkdown(`**Last 5 hours:** ${value}\n\n`);
    } else {
      md.appendMarkdown(`**Last 5 hours:** unavailable\n\n`);
    }

    if (status.budget.oneWeek !== null) {
      const value = this.formatDetailed(status.budget.oneWeek);
      md.appendMarkdown(`**Last 7 days:** ${value}\n\n`);
    } else {
      md.appendMarkdown(`**Last 7 days:** unavailable\n\n`);
    }

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

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
