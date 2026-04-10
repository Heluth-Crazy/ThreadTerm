export interface CustomSlashCommand {
  id: string;
  name: string;
  description: string;
  prompt: string;
  provider: 'claude' | 'codex' | 'cursor' | 'all';
}
