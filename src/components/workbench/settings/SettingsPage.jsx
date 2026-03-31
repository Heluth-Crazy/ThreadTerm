import Settings from '../../Settings';

export default function SettingsPage({ initialTab = 'agents' }) {
  return <Settings isOpen embedded initialTab={initialTab} onClose={() => {}} />;
}
