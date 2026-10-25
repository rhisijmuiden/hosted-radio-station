import { createContext, useContext } from 'react';
import type { Theme } from './theme';

export const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: 'light', setTheme: () => {} });
export const useThemeContext = () => useContext(ThemeContext);
