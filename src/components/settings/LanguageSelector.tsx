import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { languages } from '../../i18n/languages';
import { emitSettingsChanged } from '../../lib/settingsSync';
import { SettingsSection } from './SettingsSection';

interface LanguageSelectorProps {
  compact?: boolean;
}

function LanguageSelector({ compact = false }: LanguageSelectorProps) {
  const { i18n, t } = useTranslation('settings');
  const selectedLanguage = languages.some((lang) => lang.value === i18n.language)
    ? i18n.language
    : 'zh-CN';

  const handleLanguageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = event.target.value;
    void i18n.changeLanguage(newLanguage).then(() =>
      emitSettingsChanged({
        domain: 'language',
        language: newLanguage,
        sourceWindow: 'settings',
      }),
    );
  };

  if (compact) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border bg-card/80 backdrop-blur-md p-3 transition-all hover:bg-accent hover:border-primary/40">
        <span className="flex items-center gap-2 text-sm text-foreground/90">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t('account.language')}
        </span>
        <select
          value={selectedLanguage}
          onChange={handleLanguageChange}
          className="h-9 w-[114px] rounded-md border border-border bg-background/50 backdrop-blur-sm px-3 text-sm text-foreground outline-none transition-all focus:ring-2 focus:ring-ring/40"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <SettingsSection className="transition-all hover:border-primary/40">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-foreground/90">
            <Languages className="h-4 w-4 text-muted-foreground" />
            <div className="font-medium tracking-tight">{t('account.languageLabel')}</div>
          </div>
          <div className="text-sm leading-5 text-muted-foreground/80">
            {t('account.languageDescription')}
          </div>
        </div>
        <select
          value={selectedLanguage}
          onChange={handleLanguageChange}
          className="h-10 w-40 rounded-md border border-border bg-background/50 backdrop-blur-sm px-3 text-sm text-foreground outline-none transition-all focus:ring-2 focus:ring-ring/40"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    </SettingsSection>
  );
}

export default LanguageSelector;
