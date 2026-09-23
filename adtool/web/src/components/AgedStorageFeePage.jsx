import AgedStorageFeeTool from './AgedStorageFeeTool.jsx';
import './AgedStorageFeePage.css';

export default function AgedStorageFeePage() {
  return <div className="aged-page animate-in">
    <div className="page-head"><h1>FBA 超龄仓储费</h1><p className="hint">导入库存表后，全体账号可查看并修正同一份结果。</p></div>
    <AgedStorageFeeTool />
  </div>;
}
