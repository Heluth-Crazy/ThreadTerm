// F01: a damaged optional TLS identity is recoverable, but only through an
// explicit reset that every paired device must follow with a new pairing.
type Props = { error: string; busy: boolean; text: (cn: string, en: string) => string; onReset: () => void };
export function RemoteIdentityRecovery({ error, busy, text, onReset }: Props) {
  return <div>
    <p className="surface-error" role="alert">{error}</p>
    <p className="hint">{text("重置远程身份会生成新的证书和密钥，并要求所有已配对设备重新配对；终端、Chat 和本地设置不受影响。", "Resetting the remote identity creates a new certificate and key, and every paired device must pair again. Terminals, Chat and local settings are unaffected.")}</p>
    <div className="inline-actions"><button className="btn btn-sm btn-danger" disabled={busy} onClick={onReset}>{text("重置远程身份", "Reset remote identity")}</button></div>
  </div>;
}
