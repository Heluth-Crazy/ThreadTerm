import { fileLocationMenuItem, type FileLocationTarget } from '../fileLocation';
import { Icon } from './PrototypeIcon';
export function FileLocationButton({target,zh,onIssue}:{target:FileLocationTarget;zh:boolean;onIssue?:(message:string)=>void}){
  const action=fileLocationMenuItem(target,zh,onIssue);
  return <button type="button" className="icon-btn icon-btn-sm file-bar-secondary" title={action.reason??action.label} aria-label={action.label} disabled={action.disabled} data-testid="file-location-button" onClick={()=>void action.onSelect?.()}><Icon name="folder"/></button>;
}
