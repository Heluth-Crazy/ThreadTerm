import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { languages } from '../i18n/languages';

function LanguageSelector({ compact = false }) {
  const { i18n, t } = useTranslation('settings');

  const handleLanguageChange = (event) => {
    const newLanguage = event.target.value;
    i18n.changeLanguage(newLanguage);
  };

  if (compact) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/70 p-3 transition-colors hover:bg-card">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t('account.language')}
        </span>
        <select
          value={i18n.language}
          onChange={handleLanguageChange}
          className="h-9 w-[108px] rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
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
    <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-foreground">
            <Languages className="h-4 w-4 text-muted-foreground" />
            <div className="font-medium">{t('account.languageLabel')}</div>
          </div>
          <div className="text-sm leading-5 text-muted-foreground">
            {t('account.languageDescription')}
          </div>
        </div>
        <select
          value={i18n.language}
          onChange={handleLanguageChange}
          className="h-10 w-36 rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default LanguageSelector;
