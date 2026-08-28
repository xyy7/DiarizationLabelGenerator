import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';

import Workbench from './pages/Workbench';
import Annotator from './pages/Annotator';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* autoInsertSpace renders 「保存」as 「保 存」-- odd to read, and it makes
        every two-character label unstable to match in tests. */}
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Workbench />} />
          {/* Deep-linkable: "go and annotate this one" is a message someone
              sends a colleague. */}
          <Route path="/rec/:id" element={<Annotator />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
);
