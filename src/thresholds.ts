import * as vscode from 'vscode';

export type Level = 'high' | 'medium' | 'low' | 'none';

export function levelFor(pct: number | undefined): Level {
  if (pct === undefined) {
    return 'none';
  }
  const config = vscode.workspace.getConfiguration('dartboard');
  const low = config.get<number>('lowThreshold', 50);
  const high = config.get<number>('highThreshold', 80);
  if (pct >= high) {
    return 'high';
  }
  if (pct >= low) {
    return 'medium';
  }
  return 'low';
}

export function themeColorFor(level: Level): vscode.ThemeColor {
  switch (level) {
    case 'high':
      return new vscode.ThemeColor('charts.green');
    case 'medium':
      return new vscode.ThemeColor('charts.yellow');
    case 'low':
      return new vscode.ThemeColor('charts.red');
    default:
      return new vscode.ThemeColor('disabledForeground');
  }
}
