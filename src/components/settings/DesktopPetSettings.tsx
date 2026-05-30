import { BellRing, Cat, Monitor, Moon, Move, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauriEnv } from '../../lib/tauri-bridge';
import {
  DESKTOP_PET_DEFAULT_POSITIONS,
  DESKTOP_PET_SKINS,
  notificationModeToToggles,
  togglesToNotificationMode,
} from '../../lib/petConfig';
import { PetSprite } from '../../pet/PetSprite';
import { useTerminalStore } from '../../stores/terminalStore';

export function DesktopPetSettings() {
  const { t } = useTranslation('settings');
  const petConfig = useTerminalStore((state) => state.petConfig);
  const updatePetConfig = useTerminalStore((state) => state.updatePetConfig);

  const { petBubble, osNotification } = notificationModeToToggles(petConfig.notificationMode);

  const setNotify = (next: { petBubble?: boolean; osNotification?: boolean }) => {
    updatePetConfig({
      notificationMode: togglesToNotificationMode(
        next.petBubble ?? petBubble,
        next.osNotification ?? osNotification,
      ),
    });
  };

  return (
    <section className="rounded-[var(--radius)] border border-white/10 bg-white/5 backdrop-blur-md p-4 shadow-sm">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Cat className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-base font-semibold text-foreground">
                {t('desktopPet.title')}
              </h3>
            </div>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {t('desktopPet.description')}
            </p>
            {!isTauriEnv() && (
              <p className="mt-2 text-xs text-amber-600">{t('desktopPet.desktopOnly')}</p>
            )}
          </div>
          <label className="inline-flex shrink-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={petConfig.enabled}
              disabled={!isTauriEnv()}
              onChange={(event) => updatePetConfig({ enabled: event.target.checked })}
            />
            <span>{petConfig.enabled ? t('desktopPet.enabled') : t('desktopPet.disabled')}</span>
          </label>
        </div>

        {/* Skin picker + live preview */}
        <fieldset className="space-y-2">
          <legend className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Cat className="h-3.5 w-3.5" />
            {t('desktopPet.skin.label')}
          </legend>
          <div className="flex items-center gap-4">
            <div
              className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border/70 bg-black/20"
              aria-hidden="true"
            >
              <PetSprite mood="happy" unreadCount={0} size={64} skin={petConfig.skin} />
            </div>
            <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
              {DESKTOP_PET_SKINS.map((skin) => (
                <label
                  key={skin}
                  className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border/70 px-3 py-2 text-xs hover:bg-accent/50"
                >
                  <input
                    type="radio"
                    name="desktop-pet-skin"
                    className="accent-primary"
                    checked={petConfig.skin === skin}
                    onChange={() => updatePetConfig({ skin })}
                  />
                  <span>{t(`desktopPet.skin.${skin}`)}</span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        <div className="grid gap-4 md:grid-cols-2">
          <fieldset className="space-y-2">
            <legend className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <BellRing className="h-3.5 w-3.5" />
              {t('desktopPet.notify.label')}
            </legend>
            <div className="grid gap-2">
              <label className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border/70 px-3 py-2 text-xs hover:bg-accent/50">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={petBubble}
                  onChange={(event) => setNotify({ petBubble: event.target.checked })}
                />
                <span>{t('desktopPet.notify.petBubble')}</span>
              </label>
              <label className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border/70 px-3 py-2 text-xs hover:bg-accent/50">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={osNotification}
                  onChange={(event) => setNotify({ osNotification: event.target.checked })}
                />
                <span>{t('desktopPet.notify.os')}</span>
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Move className="h-3.5 w-3.5" />
              {t('desktopPet.position.label')}
            </legend>
            <div className="grid gap-2">
              {DESKTOP_PET_DEFAULT_POSITIONS.map((position) => (
                <label
                  key={position}
                  className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border/70 px-3 py-2 text-xs hover:bg-accent/50"
                >
                  <input
                    type="radio"
                    name="desktop-pet-position"
                    className="accent-primary"
                    checked={petConfig.defaultPosition === position}
                    onChange={() => updatePetConfig({ defaultPosition: position })}
                  />
                  <span>{t(`desktopPet.position.${position}`)}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-border/70 px-3 py-2 text-xs hover:bg-accent/50"
              onClick={() =>
                updatePetConfig({ defaultPosition: 'rightBottom', lastPosition: null })
              }
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('desktopPet.resetPosition')}
            </button>
          </fieldset>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('desktopPet.size')}
              <span className="font-mono text-[11px] text-foreground">{petConfig.size}px</span>
            </span>
            <input
              type="range"
              min={80}
              max={120}
              step={4}
              value={petConfig.size}
              onChange={(event) => updatePetConfig({ size: Number(event.target.value) })}
              className="w-full accent-primary"
            />
          </label>

          <label className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border/70 px-3 py-2 text-xs">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={petConfig.idleTranslucent}
              onChange={(event) => updatePetConfig({ idleTranslucent: event.target.checked })}
            />
            <span className="flex min-w-0 items-center gap-2">
              <Moon className="h-3.5 w-3.5 text-muted-foreground" />
              {t('desktopPet.idleTranslucent')}
            </span>
          </label>
        </div>

        <p className="flex items-center gap-2 text-[11px] leading-4 text-muted-foreground">
          <Monitor className="h-3.5 w-3.5 shrink-0" />
          {t('desktopPet.hint')}
        </p>
      </div>
    </section>
  );
}
