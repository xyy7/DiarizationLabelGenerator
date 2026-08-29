/**
 * Keyboard reference.
 *
 * Annotation is a keyboard job -- hands stay on the keys for hours -- so the
 * shortcuts have to be discoverable without hunting through documentation.
 * `?` opens this from anywhere, and the essentials stay visible on a one-line
 * bar so nobody has to open it in the first place.
 */

import { Modal } from 'antd';

export interface Shortcut {
  keys: string[];
  what: string;
  /** Shown greyed when the action needs a selected segment. */
  needsSelection?: boolean;
}

export const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: '播放',
    items: [
      { keys: ['空格'], what: '播放 / 暂停' },
      { keys: ['Enter'], what: '重听当前片段', needsSelection: true },
      { keys: ['←', '→'], what: '后退 / 前进 1 秒（⇧ 为 5 秒）' },
      { keys: ['-', '='], what: '降低 / 提高倍速' },
    ],
  },
  {
    title: '走查',
    items: [
      { keys: ['J', '↓'], what: '下一段并试听' },
      { keys: ['K', '↑'], what: '上一段并试听' },
      { keys: ['Esc'], what: '取消选中' },
    ],
  },
  {
    title: '修改',
    items: [
      { keys: ['1', '…', '9'], what: '把选中片段改判给第 N 位说话人', needsSelection: true },
      { keys: ['I'], what: '自动识别相似度（右键片段亦可）', needsSelection: true },
      { keys: ['N'], what: '新建说话人（选中时把这片段拆给他）' },
      { keys: ['S'], what: '在播放头处拆分', needsSelection: true },
      { keys: ['M'], what: '与同一说话人的下一段合并', needsSelection: true },
      { keys: ['Del'], what: '删除片段', needsSelection: true },
    ],
  },
  {
    title: '边界',
    items: [
      { keys: ['['], what: '起点吸附到播放头', needsSelection: true },
      { keys: [']'], what: '终点吸附到播放头', needsSelection: true },
      { keys: [',', '.'], what: '终点微调 ∓10ms（⇧ 为 100ms）', needsSelection: true },
    ],
  },
  {
    title: '其他',
    items: [
      { keys: ['Ctrl', 'Z'], what: '撤销（连续微调算一步）' },
      { keys: ['Ctrl', '⇧', 'Z'], what: '重做' },
      { keys: ['Ctrl', 'S'], what: '保存' },
      { keys: ['?'], what: '打开这个面板' },
      { keys: ['Tab'], what: '焦点导航（留给浏览器，不做别的用途）' },
    ],
  },
];

const kbd: React.CSSProperties = {
  display: 'inline-block',
  minWidth: 20,
  padding: '1px 6px',
  margin: '0 2px',
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  lineHeight: '18px',
  textAlign: 'center',
  color: '#333',
  background: '#fafafa',
  border: '1px solid #d9d9d9',
  borderBottomWidth: 2,
  borderRadius: 4,
};

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`}>
          {i > 0 && <span style={{ color: '#bbb', fontSize: 11 }}> </span>}
          <kbd style={kbd}>{k}</kbd>
        </span>
      ))}
    </span>
  );
}

/** The handful worth keeping on screen permanently. */
export function ShortcutBar({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <span><Keys keys={['J']} /><Keys keys={['K']} /> 走查</span>
      <span><Keys keys={['空格']} /> 播放</span>
      <span><Keys keys={['1', '…', '9']} /> 改判</span>
      <span><Keys keys={['N']} /> 新说话人</span>
      <span><Keys keys={['S']} /> 拆分</span>
      <span><Keys keys={['M']} /> 合并</span>
      <span><Keys keys={[',']} /><Keys keys={['.']} /> 微调</span>
      <a onClick={onOpen} style={{ fontSize: 12 }}>
        全部快捷键 <Keys keys={['?']} />
      </a>
    </div>
  );
}

export default function ShortcutHelp({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={640} title="快捷键">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>
        {GROUPS.map((g) => (
          <div key={g.title} style={{ marginBottom: 18, breakInside: 'avoid' }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: '#555' }}>{g.title}</div>
            {g.items.map((s) => (
              <div
                key={s.what}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 8,
                  marginBottom: 4, fontSize: 13,
                }}
              >
                <span style={{ flex: '0 0 108px' }}><Keys keys={s.keys} /></span>
                <span style={{ color: s.needsSelection ? '#888' : '#222' }}>{s.what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
        灰色的动作需要先选中一个片段（用 <Keys keys={['J']} /> 走查或直接点击）。
        在输入框里打字时所有快捷键都不生效。
      </div>
    </Modal>
  );
}
