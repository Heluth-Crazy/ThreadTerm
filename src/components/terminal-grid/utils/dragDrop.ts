export const SESSION_DRAG_FORMATS = ['text/x-openwork-session', 'application/json'];

export const hasSessionDragData = (dataTransfer: DataTransfer): boolean => {
  const types = Array.from(dataTransfer.types || []);
  return SESSION_DRAG_FORMATS.some((format) => types.includes(format));
};

export interface SessionDragData {
  sessionId: string;
  sessionName?: string;
  provider?: string;
  projectName?: string;
  projectPath?: string;
}

export const parseSessionDragData = (dataTransfer: DataTransfer): SessionDragData | null => {
  for (const format of SESSION_DRAG_FORMATS) {
    const raw = dataTransfer.getData(format);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.sessionId === 'string') {
        return parsed;
      }
    } catch {
      // Ignore invalid payload and continue with other MIME types.
    }
  }

  return null;
};
