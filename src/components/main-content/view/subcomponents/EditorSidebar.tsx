import { useState } from 'react';
import CodeEditor from '../../../CodeEditor';
import type { EditorSidebarProps } from '../../types/types';

const AnyCodeEditor = CodeEditor as any;

export default function EditorSidebar({
  editingFile,
  editorExpanded,
  editorWidth,
  resizeHandleRef,
  onResizeStart,
  onCloseEditor,
  onToggleEditorExpand,
  projectPath,
  fillSpace,
}: EditorSidebarProps) {
  const [poppedOut, setPoppedOut] = useState(false);

  if (!editingFile) {
    return null;
  }

  if (poppedOut) {
    return (
      <AnyCodeEditor
        file={editingFile}
        onClose={() => {
          setPoppedOut(false);
          onCloseEditor();
        }}
        projectPath={projectPath}
        isSidebar={false}
      />
    );
  }

  const useFlex = editorExpanded || fillSpace;

  return (
    <>
      {!editorExpanded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="group relative w-1 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-blue-500 dark:bg-gray-700 dark:hover:bg-blue-600"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-blue-600" />
        </div>
      )}

      <div
        className={`h-full flex-shrink-0 overflow-hidden border-l border-gray-200 dark:border-gray-700 ${useFlex ? 'flex-1' : ''}`}
        style={useFlex ? undefined : { width: `${editorWidth}px` }}
      >
        <AnyCodeEditor
          file={editingFile}
          onClose={onCloseEditor}
          projectPath={projectPath}
          isSidebar
          isExpanded={editorExpanded}
          onToggleExpand={onToggleEditorExpand}
          onPopOut={() => setPoppedOut(true)}
        />
      </div>
    </>
  );
}
