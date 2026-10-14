import { APP_VERSION } from '../version';

/** The app version, small and quiet: in a corner of the sign-in screen and in the Start menu. */
export function VersionTag({ className = '' }: { className?: string }) {
  return (
    <span className={`version-tag ${className}`} title={`Wallet Click version ${APP_VERSION}`}>
      Wallet Click v{APP_VERSION}
    </span>
  );
}
