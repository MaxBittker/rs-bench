import { html } from '../html.js';
import { useRoute } from '../router.js';
import { Hero } from './Hero.js';
import { Teaser } from './Teaser.js';
import { Overview } from './Overview.js';
import { CumulativeChart } from './CumulativeChart.js';
import { Heatmap } from './Heatmap.js';
import { BenchmarkDesign } from './BenchmarkDesign.js';
import { Footer } from './Footer.js';
import { TrajectoryModal } from './TrajectoryModal.js';
import { SkillPicker } from './SkillPicker.js';

export function App() {
  const route = useRoute();
  const data = window.COMBINED_DATA || null;

  return html`
    <${React.Fragment}>
      <${Hero} />
      <${Teaser} />
      <${Overview} />
      <${CumulativeChart} data=${data} />
      <${Heatmap} data=${data} />
      <${BenchmarkDesign} />
      <${Footer} />

      ${route.page === 'model' && html`
        <${SkillPicker} model=${route.model} data=${data} />
      `}

      ${route.page === 'trajectory' && html`
        <${TrajectoryModal} model=${route.model} skill=${route.skill} data=${data} />
      `}
    </${React.Fragment}>
  `;
}
