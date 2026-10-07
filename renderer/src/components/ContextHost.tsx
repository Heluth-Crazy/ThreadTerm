import { createContext } from 'react';
import type { FileCommentsHost } from '../fileCommentsHost';

/** The workspace supplies the same receiver set used by file comments. */
export const ContextHost = createContext<FileCommentsHost | undefined>(undefined);
