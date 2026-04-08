/**
 * Desktop Notification Utility
 * Provides native notification functionality with web fallback
 *
 * Features:
 * - Native Electron notifications via IPC
 * - Web Notification API fallback
 * - macOS permission request
 * - Convenient methods: notifySuccess, notifyError, notifyInfo
 */
import { logger } from '../utils/logger';

/**
 * Check if running in Electron environment
 * @returns {boolean}
 */
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

/**
 * Check if Web Notifications are supported
 * @returns {boolean}
 */
const isWebNotificationSupported = () => {
  return typeof window !== 'undefined' && 'Notification' in window;
};

/**
 * Request notification permission
 * On macOS, this requests native permission
 * On web, this requests browser permission
 * @returns {Promise<string>} Permission status ('granted', 'denied', or 'default')
 */
export const requestNotificationPermission = async () => {
  if (isElectron()) {
    return window.electronAPI.notification.requestPermission();
  }

  if (isWebNotificationSupported()) {
    return Notification.requestPermission();
  }

  return 'denied';
};

/**
 * Show a notification
 * Uses native Electron notifications when available, falls back to Web Notifications
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {Object} options - Additional options
 * @param {string} options.icon - Icon path or URL
 * @param {boolean} options.silent - Whether to suppress sound
 * @param {Function} options.onClick - Click handler
 * @param {Function} options.onClose - Close handler
 * @param {Function} options.onError - Error handler
 * @returns {Notification|void} Notification instance (web) or undefined (electron)
 */
export const showNotification = (title, body, options = {}) => {
  const { icon, silent, onClick, onClose, onError } = options;

  // Electron native notification
  if (isElectron()) {
    window.electronAPI.notification.show({
      title,
      body,
      icon,
      silent,
    });

    // Note: Electron notifications don't support direct callback attachment
    // The main process would need to send back events via IPC for full callback support
    if (onClick) {
      logger.warn('Notification click handlers are not fully supported in Electron mode');
    }
    return;
  }

  // Web Notification fallback
  if (isWebNotificationSupported()) {
    if (Notification.permission !== 'granted') {
      logger.warn('Notification permission not granted');
      return;
    }

    const notification = new Notification(title, {
      body,
      icon,
      silent,
    });

    if (onClick) {
      notification.onclick = onClick;
    }
    if (onClose) {
      notification.onclose = onClose;
    }
    if (onError) {
      notification.onerror = onError;
    }

    return notification;
  }

  // Final fallback: console log
  logger.log(`[Notification] ${title}: ${body}`);
};

/**
 * Show a success notification
 * @param {string} message - Notification message
 * @param {string} title - Notification title (default: 'Success')
 * @param {Object} options - Additional options
 */
export const notifySuccess = (message, title = 'Success', options = {}) => {
  showNotification(title, message, {
    ...options,
    icon: options.icon || '/icon-success.png',
  });
};

/**
 * Show an error notification
 * @param {string} message - Notification message
 * @param {string} title - Notification title (default: 'Error')
 * @param {Object} options - Additional options
 */
export const notifyError = (message, title = 'Error', options = {}) => {
  showNotification(title, message, {
    ...options,
    icon: options.icon || '/icon-error.png',
    silent: options.silent ?? false, // Error notifications should play sound by default
  });
};

/**
 * Show an info notification
 * @param {string} message - Notification message
 * @param {string} title - Notification title (default: 'Information')
 * @param {Object} options - Additional options
 */
export const notifyInfo = (message, title = 'Information', options = {}) => {
  showNotification(title, message, {
    ...options,
    icon: options.icon || '/icon-info.png',
  });
};

/**
 * Check if notifications are permitted
 * @returns {boolean}
 */
export const hasNotificationPermission = () => {
  if (isElectron()) {
    // Electron notifications are always allowed at the app level
    // macOS permission is handled by the system
    return true;
  }

  if (isWebNotificationSupported()) {
    return Notification.permission === 'granted';
  }

  return false;
};

/**
 * Get current notification permission status
 * @returns {string} 'granted', 'denied', 'default', or 'unsupported'
 */
export const getNotificationPermissionStatus = () => {
  if (isElectron()) {
    return 'granted'; // Electron handles permission at system level
  }

  if (isWebNotificationSupported()) {
    return Notification.permission;
  }

  return 'unsupported';
};

/**
 * Initialize notification system
 * Requests permission on macOS and sets up any necessary handlers
 * @returns {Promise<boolean>} Whether notifications are available
 */
export const initializeNotifications = async () => {
  // Check if already permitted
  if (hasNotificationPermission()) {
    return true;
  }

  // Request permission
  const permission = await requestNotificationPermission();
  return permission === 'granted';
};

// Default export with all notification utilities
export default {
  show: showNotification,
  notifySuccess,
  notifyError,
  notifyInfo,
  requestPermission: requestNotificationPermission,
  hasPermission: hasNotificationPermission,
  getPermissionStatus: getNotificationPermissionStatus,
  initialize: initializeNotifications,
};
