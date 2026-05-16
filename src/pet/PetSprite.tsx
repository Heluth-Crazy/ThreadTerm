import { Bell, Moon, Sparkles } from 'lucide-react';
import type { DesktopPetSkin } from '../types/terminal';
import { petSkinStyle } from './petSkins';
import './petSprite.css';

export type PetSpriteMood = 'idle' | 'alert' | 'happy' | 'sleep';

interface PetSpriteProps {
  mood: PetSpriteMood;
  unreadCount: number;
  size: number;
  skin?: DesktopPetSkin;
}

export function PetSprite({ mood, unreadCount, size, skin = 'classic' }: PetSpriteProps) {
  const showBadge = unreadCount > 0;

  return (
    <div
      className={`pet-sprite pet-sprite-${mood}`}
      style={{ ...petSkinStyle(skin), width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 96 96" className="pet-sprite-svg">
        <defs>
          <radialGradient id="pet-body" cx="42%" cy="32%" r="78%">
            <stop offset="0" stopColor="var(--pet-fur-light)" />
            <stop offset="0.55" stopColor="var(--pet-fur-mid)" />
            <stop offset="1" stopColor="var(--pet-fur-dark)" />
          </radialGradient>
          <linearGradient id="pet-tail-grad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--pet-fur-mid)" />
            <stop offset="1" stopColor="var(--pet-fur-dark)" />
          </linearGradient>
          <radialGradient id="pet-belly-grad" cx="50%" cy="50%" r="55%">
            <stop offset="0" stopColor="var(--pet-belly)" />
            <stop offset="1" stopColor="var(--pet-belly)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="pet-top-glow" cx="44%" cy="20%" r="58%">
            <stop offset="0" stopColor="white" stopOpacity="0.6" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <filter id="pet-shadow" x="-30%" y="-20%" width="160%" height="150%">
            <feDropShadow dx="0" dy="3" stdDeviation="2.4" floodColor="black" floodOpacity="0.3" />
          </filter>
        </defs>

        {/* Tail — curls out from the lower right and sways. Anchor kept at
            66,70 to match `.pet-tail { transform-origin: 66px 70px }`. */}
        <path
          className="pet-tail"
          d="M66 78 C82 80 90 66 86 54 C84 47 76 45 73 51 C77 54 79 60 76 65 C73 70 68 72 64 74Z"
          fill="url(#pet-tail-grad)"
          stroke="var(--pet-stroke)"
          strokeWidth="0.4"
        />

        {/* Small merged body/base so it reads as a big-head cartoon cat. */}
        <path
          className="pet-body"
          d="M30 78 C30 66 38 60 48 60 C58 60 66 66 66 78 C66 89 58 93 48 93 C38 93 30 89 30 78Z"
          fill="url(#pet-body)"
          stroke="var(--pet-stroke)"
          strokeWidth="0.4"
          filter="url(#pet-shadow)"
        />

        {/* Head — large and round, the dominant feature. */}
        <g className="pet-head">
          {/* Ears: isosceles triangles, roots seated on the head crown. */}
          <path
            className="pet-ear pet-ear-left"
            d="M24 30 L20 7 L43 22Z"
            fill="url(#pet-body)"
            stroke="var(--pet-stroke)"
            strokeWidth="0.4"
            strokeLinejoin="round"
          />
          <path
            className="pet-ear pet-ear-right"
            d="M72 30 L76 7 L53 22Z"
            fill="url(#pet-body)"
            stroke="var(--pet-stroke)"
            strokeWidth="0.4"
            strokeLinejoin="round"
          />
          <path
            className="pet-ear-inner pet-ear-left"
            d="M26 28 L24 13 L39 23Z"
            fill="var(--pet-ear-inner)"
            strokeLinejoin="round"
          />
          <path
            className="pet-ear-inner pet-ear-right"
            d="M70 28 L72 13 L57 23Z"
            fill="var(--pet-ear-inner)"
            strokeLinejoin="round"
          />

          {/* Round head */}
          <path
            className="pet-face"
            d="M16 46 C16 27 30 17 48 17 C66 17 80 27 80 46 C80 65 66 75 48 75 C30 75 16 65 16 46Z"
            fill="url(#pet-body)"
            stroke="var(--pet-stroke)"
            strokeWidth="0.4"
            filter="url(#pet-shadow)"
          />
          {/* Muzzle patch + crown glow for volume */}
          <ellipse cx="48" cy="56" rx="17" ry="13" fill="url(#pet-belly-grad)" />
          <path
            d="M22 40 C26 26 36 21 48 21 C60 21 70 26 74 40 C66 32 58 28 48 28 C38 28 30 32 22 40Z"
            fill="url(#pet-top-glow)"
          />

          {/* Cheeks */}
          <circle className="pet-cheek" cx="28" cy="52" r="4.6" />
          <circle className="pet-cheek" cx="68" cy="52" r="4.6" />

          {/* Eyes — large, slightly toward centre, three mood forms. */}
          <g className="pet-eyes">
            {mood === 'sleep' ? (
              <>
                <path d="M31 46 C35 50 41 50 45 46" className="pet-eye-line" />
                <path d="M51 46 C55 50 61 50 65 46" className="pet-eye-line" />
              </>
            ) : mood === 'happy' ? (
              <>
                <path d="M31 48 C35 42 41 42 45 48" className="pet-eye-line" />
                <path d="M51 48 C55 42 61 42 65 48" className="pet-eye-line" />
              </>
            ) : (
              <>
                <g className="pet-eye pet-eye-left">
                  <ellipse cx="38" cy="46" rx="5.4" ry="7" className="pet-eye-ball" />
                  <circle cx="39.8" cy="43.2" r="1.9" className="pet-eye-shine" />
                </g>
                <g className="pet-eye pet-eye-right">
                  <ellipse cx="58" cy="46" rx="5.4" ry="7" className="pet-eye-ball" />
                  <circle cx="59.8" cy="43.2" r="1.9" className="pet-eye-shine" />
                </g>
              </>
            )}
          </g>

          {/* Nose: small triangle just below the eyes; compact w mouth. */}
          <path d="M45.4 55 L50.6 55 L48 58.4Z" className="pet-nose" />
          <path d="M48 58 L48 61 M48 61 C48 64 45 65 42 63 M48 61 C48 64 51 65 54 63" className="pet-mouth" />

          {/* Whiskers — fan out level with the muzzle. */}
          <g className="pet-whiskers">
            <path d="M27 54 L11 51 M27 58 L11 59 M27 62 L12 66" />
            <path d="M69 54 L85 51 M69 58 L85 59 M69 62 L84 66" />
          </g>

          {/* Alert rays */}
          {mood === 'alert' && (
            <g className="pet-alert-rays">
              <path d="M18 22 L10 15" />
              <path d="M78 22 L86 15" />
              <path d="M48 8 L48 1" />
            </g>
          )}
        </g>
      </svg>

      {mood === 'sleep' && <Moon className="pet-floating-icon pet-sleep-icon" />}
      {mood === 'happy' && <Sparkles className="pet-floating-icon pet-happy-icon" />}
      {showBadge && (
        <span className="pet-badge" aria-label={`${unreadCount} unread`}>
          <Bell className="h-3 w-3" />
          {unreadCount}
        </span>
      )}
    </div>
  );
}
