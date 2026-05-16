import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Minimize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke, isTauriEnv } from '../lib/tauri-bridge';
import { PetPanel } from './PetPanel';
import { PetSprite, type PetSpriteMood } from './PetSprite';
import { usePetSync } from './usePetSync';
import { usePetGeometry } from './usePetGeometry';
import './petAnimations.css';

const PET_EXPANDED_WIDTH = 296;
const PET_EXPANDED_HEIGHT = 380;

export function PetWindow() {
  const { t } = useTranslation('settings');
  const petLocalRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const {
    state,
    latestNotification,
    setBubbleHovered,
    setExpanded,
    focusCard,
    openNotificationCenter,
    updateConfig,
  } = usePetSync({ petLocalRef });
  const [hovered, setHovered] = useState(false);

  const { geometry } = usePetGeometry({
    enabled: state.config.enabled,
    expanded: state.config.expanded,
    hasBubble: latestNotification !== null,
    config: state.config,
  });

  // Keep the live sprite-local offset available to the drag handler so a
  // bubble-grown window never drifts the persisted anchor.
  petLocalRef.current = geometry
    ? { x: geometry.petLocalX, y: geometry.petLocalY }
    : { x: 0, y: 0 };

  const mood = useMemo<PetSpriteMood>(() => {
    if (latestNotification) return 'alert';
    if (hovered) return 'happy';
    if (state.unreadCount > 0 || state.cards.some((card) => card.status === 'failed')) {
      return 'alert';
    }
    if (state.config.idleTranslucent && state.cards.length === 0) {
      return 'sleep';
    }
    return 'idle';
  }, [hovered, latestNotification, state.cards, state.config.idleTranslucent, state.unreadCount]);

  const toggleExpanded = () => {
    void setExpanded(!state.config.expanded);
  };

  const hide = () => {
    void updateConfig({ enabled: false, expanded: false });
    if (isTauriEnv()) {
      void invoke('pet_hide');
    }
  };

  const hasGeometry = geometry !== null;
  const size = state.config.size;

  // Absolute placement from the resolved geometry. Falls back to centring
  // the sprite when geometry hasn't arrived (initial frame / non-Tauri).
  const spriteStyle: CSSProperties = hasGeometry
    ? {
        position: 'absolute',
        left: geometry.petLocalX,
        top: geometry.petLocalY,
        width: size,
        height: size,
      }
    : { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' };

  const contentStyle: CSSProperties = hasGeometry
    ? { position: 'absolute', left: geometry.contentLocalX, top: geometry.contentLocalY }
    : { position: 'absolute', left: 0, top: 0 };

  const side = geometry?.side ?? 'left';

  return (
    <main
      className={[
        'pet-window',
        state.config.expanded ? 'pet-window-expanded' : 'pet-window-collapsed',
        state.config.idleTranslucent && mood === 'sleep' ? 'pet-window-sleep' : '',
      ].join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={spriteStyle}>
        {!state.config.expanded && <div className="pet-drag-strip" data-tauri-drag-region />}
        <button
          type="button"
          className="pet-sprite-button"
          onClick={toggleExpanded}
          aria-label={state.config.expanded ? t('desktopPet.collapse') : t('desktopPet.expand')}
        >
          <PetSprite
            mood={mood}
            unreadCount={state.unreadCount}
            size={size}
            skin={state.config.skin}
          />
        </button>
      </div>

      {/* Content gating: only render the bubble/panel once the resolved
          geometry has arrived. Rendering 296×380 (or the bubble) against a
          stale collapsed geometry (96px OS window, contentLocal 0,0) gets it
          clipped to a tiny dot by `.pet-window { overflow:hidden }`. The
          collapsed sprite keeps its centred fallback so the pet stays
          visible while geometry is in flight. */}
      {hasGeometry && latestNotification && !state.config.expanded && (
        <div
          className={`pet-toast pet-toast-${side}`}
          style={contentStyle}
          role="status"
          onMouseEnter={() => setBubbleHovered(true)}
          onMouseLeave={() => setBubbleHovered(false)}
        >
          <strong>{latestNotification.title}</strong>
          <span>{latestNotification.body}</span>
        </div>
      )}

      {hasGeometry && state.config.expanded && (
        <div
          style={{
            ...contentStyle,
            width: PET_EXPANDED_WIDTH,
            height: PET_EXPANDED_HEIGHT,
          }}
        >
          <div className="pet-panel-actions">
            <button type="button" onClick={toggleExpanded} aria-label={t('desktopPet.collapse')}>
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={hide} aria-label={t('desktopPet.disable')}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <PetPanel
            cards={state.cards}
            unreadCount={state.unreadCount}
            onFocusCard={(cardId) => void focusCard(cardId)}
            onOpenNotificationCenter={() => void openNotificationCenter()}
          />
        </div>
      )}
    </main>
  );
}
