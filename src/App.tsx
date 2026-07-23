import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { BacktestPage } from './pages/BacktestPage';
import { DetailsPage } from './pages/DetailsPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RankingPage } from './pages/RankingPage';
import { SimulatedTradingPage } from './pages/SimulatedTradingPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="details" element={<DetailsPage />} />
        <Route path="ranking" element={<RankingPage />} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="simulated-trading" element={<SimulatedTradingPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
