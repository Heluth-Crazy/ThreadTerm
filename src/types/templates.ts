export interface SessionTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  provider: 'claude' | 'codex' | 'cursor';
  systemPrompt?: string;
  initialMessage?: string;
  isBuiltIn: boolean;
}
