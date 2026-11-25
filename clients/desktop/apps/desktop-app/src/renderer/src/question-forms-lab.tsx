import './styles/app-styles';
import { createRoot } from 'react-dom/client';
import { brand } from '@/lib/brand';
import { applyBrandDocumentHead } from '@/lib/brandDocumentHead';
import { applyTheme, installBrandDefaultTheme } from '@/lib/theme';
import { QuestionFormsLabPage } from '@/components/dev/QuestionFormsLabPage';

applyBrandDocumentHead(brand);
installBrandDefaultTheme();
applyTheme('default', 'light');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(<QuestionFormsLabPage />);
