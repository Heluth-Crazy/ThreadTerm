/**
 * File Dialog Utilities
 * 封装 Electron 原生文件对话框供前端使用
 *
 * Features:
 * - selectDirectory(): 选择文件夹
 * - selectFile(): 选择文件
 * - saveFile(): 保存文件
 * - selectMultipleFiles(): 多文件选择
 */
import { logger } from '../utils/logger';

/**
 * 获取合理的默认路径
 * @returns {Promise<string|null>} 默认路径或 null
 */
async function getDefaultPath() {
  if (window.electronAPI?.appControl?.getPath) {
    try {
      // 优先使用 home 目录
      const homePath = await window.electronAPI.appControl.getPath('home');
      if (homePath) return homePath;

      // 其次使用 userData 目录
      const userDataPath = await window.electronAPI.appControl.getPath('userData');
      if (userDataPath) return userDataPath;
    } catch (error) {
      logger.warn('Failed to get default path:', error);
    }
  }
  return null;
}

/**
 * 在浏览器/预加载环境下拼接文件路径（避免直接依赖 Node path 模块）
 * @param {string} basePath
 * @param {string} fileName
 * @returns {string}
 */
function joinPath(basePath, fileName) {
  if (!basePath) {
    return fileName || '';
  }
  if (!fileName) {
    return basePath;
  }

  // 优先沿用已有路径风格，兼容 Windows/macOS/Linux
  const separator = basePath.includes('\\') ? '\\' : '/';
  const normalizedBase = basePath.replace(/[\\/]+$/, '');
  const normalizedFile = fileName.replace(/^[\\/]+/, '');
  return `${normalizedBase}${separator}${normalizedFile}`;
}

/**
 * 检查文件对话框 API 是否可用
 * @returns {boolean}
 */
export function isFileDialogAvailable() {
  return !!window.electronAPI?.showOpenDialog && !!window.electronAPI?.showSaveDialog;
}

/**
 * 选择文件夹
 * @param {Object} options - 配置选项
 * @param {string} [options.title='选择文件夹'] - 对话框标题
 * @param {string} [options.defaultPath] - 默认路径
 * @param {string} [options.buttonLabel='选择'] - 按钮标签
 * @returns {Promise<{canceled: boolean, filePaths: string[]}>} 选择结果
 */
export async function selectDirectory(options = {}) {
  if (!isFileDialogAvailable()) {
    throw new Error('File dialog API is not available. Make sure you are running in Electron.');
  }

  const defaultPath = options.defaultPath || await getDefaultPath();

  const dialogOptions = {
    title: options.title || '选择文件夹',
    defaultPath,
    buttonLabel: options.buttonLabel || '选择',
    properties: ['openDirectory', 'createDirectory'],
  };

  try {
    const result = await window.electronAPI.showOpenDialog(dialogOptions);
    return {
      canceled: result.canceled,
      filePaths: result.filePaths || [],
    };
  } catch (error) {
    console.error('Failed to show directory dialog:', error);
    throw error;
  }
}

/**
 * 选择单个文件
 * @param {Object} options - 配置选项
 * @param {string} [options.title='选择文件'] - 对话框标题
 * @param {string} [options.defaultPath] - 默认路径
 * @param {string} [options.buttonLabel='选择'] - 按钮标签
 * @param {Array<{name: string, extensions: string[]}>} [options.filters] - 文件过滤器
 * @returns {Promise<{canceled: boolean, filePaths: string[]}>} 选择结果
 */
export async function selectFile(options = {}) {
  if (!isFileDialogAvailable()) {
    throw new Error('File dialog API is not available. Make sure you are running in Electron.');
  }

  const defaultPath = options.defaultPath || await getDefaultPath();

  const dialogOptions = {
    title: options.title || '选择文件',
    defaultPath,
    buttonLabel: options.buttonLabel || '选择',
    properties: ['openFile'],
    filters: options.filters || [
      { name: '所有文件', extensions: ['*'] },
    ],
  };

  try {
    const result = await window.electronAPI.showOpenDialog(dialogOptions);
    return {
      canceled: result.canceled,
      filePaths: result.filePaths || [],
    };
  } catch (error) {
    console.error('Failed to show file dialog:', error);
    throw error;
  }
}

/**
 * 选择多个文件
 * @param {Object} options - 配置选项
 * @param {string} [options.title='选择文件'] - 对话框标题
 * @param {string} [options.defaultPath] - 默认路径
 * @param {string} [options.buttonLabel='选择'] - 按钮标签
 * @param {Array<{name: string, extensions: string[]}>} [options.filters] - 文件过滤器
 * @returns {Promise<{canceled: boolean, filePaths: string[]}>} 选择结果
 */
export async function selectMultipleFiles(options = {}) {
  if (!isFileDialogAvailable()) {
    throw new Error('File dialog API is not available. Make sure you are running in Electron.');
  }

  const defaultPath = options.defaultPath || await getDefaultPath();

  const dialogOptions = {
    title: options.title || '选择文件',
    defaultPath,
    buttonLabel: options.buttonLabel || '选择',
    properties: ['openFile', 'multiSelections'],
    filters: options.filters || [
      { name: '所有文件', extensions: ['*'] },
    ],
  };

  try {
    const result = await window.electronAPI.showOpenDialog(dialogOptions);
    return {
      canceled: result.canceled,
      filePaths: result.filePaths || [],
    };
  } catch (error) {
    console.error('Failed to show multiple files dialog:', error);
    throw error;
  }
}

/**
 * 保存文件
 * @param {Object} options - 配置选项
 * @param {string} [options.title='保存文件'] - 对话框标题
 * @param {string} [options.defaultPath] - 默认路径
 * @param {string} [options.defaultFileName] - 默认文件名
 * @param {string} [options.buttonLabel='保存'] - 按钮标签
 * @param {Array<{name: string, extensions: string[]}>} [options.filters] - 文件过滤器
 * @returns {Promise<{canceled: boolean, filePath?: string}>} 保存结果
 */
export async function saveFile(options = {}) {
  if (!isFileDialogAvailable()) {
    throw new Error('File dialog API is not available. Make sure you are running in Electron.');
  }

  let defaultPath = options.defaultPath || await getDefaultPath();

  // 如果提供了默认文件名，拼接路径
  if (options.defaultFileName && defaultPath) {
    defaultPath = joinPath(defaultPath, options.defaultFileName);
  }

  const dialogOptions = {
    title: options.title || '保存文件',
    defaultPath,
    buttonLabel: options.buttonLabel || '保存',
    filters: options.filters || [
      { name: '所有文件', extensions: ['*'] },
    ],
  };

  try {
    const result = await window.electronAPI.showSaveDialog(dialogOptions);
    return {
      canceled: result.canceled,
      filePath: result.filePath,
    };
  } catch (error) {
    console.error('Failed to show save dialog:', error);
    throw error;
  }
}

/**
 * 选择项目目录（便捷方法）
 * @param {Object} options - 配置选项
 * @returns {Promise<{canceled: boolean, filePath?: string}>} 选择结果
 */
export async function selectProjectDirectory(options = {}) {
  const result = await selectDirectory({
    title: options.title || '选择项目目录',
    buttonLabel: options.buttonLabel || '选择文件夹',
    ...options,
  });

  return {
    canceled: result.canceled,
    filePath: result.filePaths[0],
  };
}

/**
 * 常用文件过滤器预设
 */
export const FileFilters = {
  // 图片文件
  IMAGES: [
    { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'] },
    { name: '所有文件', extensions: ['*'] },
  ],
  // 文档文件
  DOCUMENTS: [
    { name: '文档文件', extensions: ['pdf', 'doc', 'docx', 'txt', 'md'] },
    { name: '所有文件', extensions: ['*'] },
  ],
  // 代码文件
  CODE: [
    { name: '代码文件', extensions: ['js', 'jsx', 'ts', 'tsx', 'json', 'html', 'css', 'py'] },
    { name: '所有文件', extensions: ['*'] },
  ],
  // JSON 文件
  JSON: [
    { name: 'JSON 文件', extensions: ['json'] },
    { name: '所有文件', extensions: ['*'] },
  ],
};

// 默认导出
export default {
  isFileDialogAvailable,
  selectDirectory,
  selectFile,
  selectMultipleFiles,
  saveFile,
  selectProjectDirectory,
  FileFilters,
};
