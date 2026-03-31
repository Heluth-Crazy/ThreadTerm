import React, { createContext, useContext } from 'react';

const TasksSettingsContext = createContext({
  tasksEnabled: false,
  setTasksEnabled: () => {},
  toggleTasksEnabled: () => {},
  isTaskMasterInstalled: false,
  isTaskMasterReady: false,
  installationStatus: null,
  isCheckingInstallation: false,
});

export const useTasksSettings = () => {
  const context = useContext(TasksSettingsContext);
  if (!context) {
    throw new Error('useTasksSettings must be used within a TasksSettingsProvider');
  }
  return context;
};

export const TasksSettingsProvider = ({ children }) => {
  const contextValue = {
    tasksEnabled: false,
    setTasksEnabled: () => {},
    toggleTasksEnabled: () => {},
    isTaskMasterInstalled: false,
    isTaskMasterReady: false,
    installationStatus: null,
    isCheckingInstallation: false,
  };

  return (
    <TasksSettingsContext.Provider value={contextValue}>
      {children}
    </TasksSettingsContext.Provider>
  );
};

export default TasksSettingsContext;
