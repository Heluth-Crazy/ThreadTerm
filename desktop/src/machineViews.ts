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
/** The native local content view and remote views are siblings under a neutral root. */
export class MachineViews<V extends MachineView> {
  private readonly views = new Map<string, V>();
  currentId = 'local';
  constructor(local: V, private readonly create: (id: string) => V, private readonly size: () => [number, number]) { this.views.set('local', local); }
  show(id: string): V {
    let view = this.views.get(id);
    if (!view) { view = this.create(id); this.views.set(id, view); }
    this.currentId = id;
    for (const [key, item] of this.views) item.setVisible(key === id);
    this.resize();
    return view;
  }
  resize(): void {
    const [width, height] = this.size();
    for (const view of this.views.values()) view.setBounds({ x: 0, y: 0, width, height });
  }
  remove(id: string): V | undefined {
    if (id === 'local') throw new Error('Cannot remove This PC');
    if (this.currentId === id) this.show('local');
    const view = this.views.get(id); this.views.delete(id); return view;
  }
  all(): V[] { return [...this.views.values()]; }
}
