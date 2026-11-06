/** Bindings are owned by main and never inferred from renderer request fields. */
export class MachineBindings<Owner> {
  private readonly bindings = new Map<number, { machineId: string; owner: Owner }>();
  bind(senderId: number, machineId: string, owner: Owner): void {
    if (this.bindings.has(senderId)) throw new Error('Renderer is already bound');
    this.bindings.set(senderId, { machineId, owner });
  }
  get(senderId: number): { machineId: string; owner: Owner } {
    const binding = this.bindings.get(senderId);
    if (!binding) throw new Error('Unbound application renderer');
    return binding;
  }
  remove(senderId: number): void { this.bindings.delete(senderId); }
}
interface MachineView {
  setVisible(visible: boolean): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}
/** Pages are siblings of the app inside the container, never children of the app. */
export interface MachineSurface<V extends MachineView, A extends MachineView = V> {
  container: V;
  /** This PC keeps its existing native content view and needs no separate app view. */
  app?: A;
}
/** The native local content view and remote containers are siblings under a neutral root. */
export class MachineViews<V extends MachineView, A extends MachineView = V> {
  private readonly views = new Map<string, MachineSurface<V, A>>();
  currentId = 'local';
  constructor(local: V, private readonly create: (id: string) => MachineSurface<V, A>, private readonly size: () => [number, number]) { this.views.set('local', { container: local }); }
  show(id: string): MachineSurface<V, A> {
    let view = this.views.get(id);
    if (!view) { view = this.create(id); this.views.set(id, view); }
    this.currentId = id;
    for (const [key, item] of this.views) item.container.setVisible(key === id);
    this.resize();
    return view;
  }
  resize(): void {
    const [width, height] = this.size();
    for (const { container, app } of this.views.values()) {
      container.setBounds({ x: 0, y: 0, width, height });
      app?.setBounds({ x: 0, y: 0, width, height });
    }
  }
  remove(id: string): MachineSurface<V, A> | undefined {
    if (id === 'local') throw new Error('Cannot remove This PC');
    if (this.currentId === id) this.show('local');
    const view = this.views.get(id); this.views.delete(id); return view;
  }
  all(): MachineSurface<V, A>[] { return [...this.views.values()]; }
}
