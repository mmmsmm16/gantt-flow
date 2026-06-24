// プロジェクトのセッション層（MCP トランスポート非依存・テスト可能）。
// 1 セッション = 開いている 1 ファイル（path）＋メモリ上の Project。
// ミューテーションは「core コマンド → reconcileProject → meta.updatedAt 更新 → アトミック保存」
// の 1 単位で適用する。これはデスクトップ版ストアの commit（コマンド→reconcile→push）と同じ
// 合成で、工程表の編集に追従してフロー図（レーン・矢印）も同期保存される（write-through）。
import {
  reconcileProject,
  ensureLevelView,
  createSampleProject,
  validate,
  uuid,
  CURRENT_SCHEMA_VERSION,
  type Project,
  type ValidationIssue,
} from '@gantt-flow/core';
import { loadProjectFile, saveProjectFile } from './fileio.js';

const APP_VERSION = '0.0.0'; // デスクトップ版 persistence.ts と同じ。保存ファイルの meta.appVersion。

/** プロジェクト未オープンで読み書きツールを呼んだとき。AI には isError で返す。 */
export class NoProjectError extends Error {
  constructor() {
    super('プロジェクトが開かれていません。先に open_project か new_project を実行してください。');
    this.name = 'NoProjectError';
  }
}

function emptyProject(title: string): Project {
  const now = new Date().toISOString();
  const base: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { id: uuid(), title, createdAt: now, updatedAt: now, appVersion: APP_VERSION },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
  };
  // 新規はデスクトップ版 initialProject と同じく medium ビューを 1 枚用意して reconcile。
  return reconcileProject(ensureLevelView(base, 'medium'), uuid);
}

export class ProjectSession {
  private constructor(
    public readonly path: string,
    public project: Project,
  ) {}

  /** 既存ファイルを開く。 */
  static async open(path: string): Promise<ProjectSession> {
    const project = await loadProjectFile(path);
    return new ProjectSession(path, project);
  }

  /** 既製の Project（CSV 取り込み等）を採用する。ビュー補完・reconcile・保存まで行う。 */
  static async fromProject(path: string, project: Project): Promise<ProjectSession> {
    const withView = project.flow.byLevel.length === 0 ? ensureLevelView(project, 'medium') : project;
    const reconciled = reconcileProject(withView, uuid);
    const stamped: Project = {
      ...reconciled,
      meta: { ...reconciled.meta, updatedAt: new Date().toISOString() },
    };
    await saveProjectFile(path, stamped);
    return new ProjectSession(path, stamped);
  }

  /** 新規プロジェクトを作成して保存する（sample=true でサンプル業務を投入）。 */
  static async create(
    path: string,
    opts: { title?: string; sample?: boolean } = {},
  ): Promise<ProjectSession> {
    const project = opts.sample
      ? createSampleProject(uuid)
      : emptyProject(opts.title ?? '新規プロジェクト');
    const titled = opts.title ? { ...project, meta: { ...project.meta, title: opts.title } } : project;
    const session = new ProjectSession(path, titled);
    await saveProjectFile(path, titled);
    return session;
  }

  /**
   * core コマンドを適用し、フロー同期・更新時刻の更新・保存まで 1 単位で行う。
   * mutate は (project) => project' の純関数（@gantt-flow/core のコマンドを uuid で束ねたもの）。
   */
  async apply(mutate: (p: Project) => Project): Promise<void> {
    const mutated = mutate(this.project);
    // 既存ビューが無いプロジェクト（空など）にだけ medium を補う。既にビューがある場合は勝手に
    // 増やさず、現状の全 byLevel を core/details に合わせて reconcile する。
    const withView = mutated.flow.byLevel.length === 0 ? ensureLevelView(mutated, 'medium') : mutated;
    const reconciled = reconcileProject(withView, uuid);
    this.project = {
      ...reconciled,
      meta: { ...reconciled.meta, updatedAt: new Date().toISOString() },
    };
    await saveProjectFile(this.path, this.project);
  }

  /** 現在の Project を別パスへ保存し、以後の保存先をそのパスに切り替える。 */
  async saveAs(path: string): Promise<ProjectSession> {
    await saveProjectFile(path, this.project);
    return new ProjectSession(path, this.project);
  }

  /** 参照整合性の問題一覧（投げない）。 */
  issues(): ValidationIssue[] {
    return validate(this.project);
  }
}

/** 「現在開いているセッション」を保持するホルダ。MCP ツール群はこれ越しに current() を使う。 */
export class Workspace {
  private session: ProjectSession | null = null;

  has(): boolean {
    return this.session !== null;
  }

  current(): ProjectSession {
    if (!this.session) throw new NoProjectError();
    return this.session;
  }

  async open(path: string): Promise<ProjectSession> {
    this.session = await ProjectSession.open(path);
    return this.session;
  }

  async create(path: string, opts?: { title?: string; sample?: boolean }): Promise<ProjectSession> {
    this.session = await ProjectSession.create(path, opts);
    return this.session;
  }

  async saveAs(path: string): Promise<ProjectSession> {
    this.session = await this.current().saveAs(path);
    return this.session;
  }

  async adopt(path: string, project: Project): Promise<ProjectSession> {
    this.session = await ProjectSession.fromProject(path, project);
    return this.session;
  }
}
