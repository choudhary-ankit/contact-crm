import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LineChart from '../components/LineChart.vue';
import Sparkline from '../components/Sparkline.vue';

describe('Sparkline', () => {
  it('draws a line and a soft area for 2 or more values', () => {
    const w = mount(Sparkline, { props: { values: [1, 3, 2, 5] } });
    expect(w.find('polyline').exists()).toBe(true);
    expect(w.find('polygon').exists()).toBe(true);
    expect(w.attributes('aria-hidden')).toBe('true'); // decorative: the number beside it says it all
  });

  it('draws nothing for fewer than 2 points and survives a flat series', () => {
    expect(mount(Sparkline, { props: { values: [] } }).find('svg').exists()).toBe(false);
    expect(mount(Sparkline, { props: { values: [4] } }).find('svg').exists()).toBe(false);
    const flat = mount(Sparkline, { props: { values: [3, 3, 3] } });
    expect(flat.find('polyline').attributes('points')).not.toContain('NaN');
  });
});

describe('LineChart', () => {
  const props = {
    labels: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
    series: [
      { name: 'New contacts', color: 'var(--chart-1)', values: [1, 4, 2, 8] },
      { name: 'Edits', color: 'var(--chart-2)', dashed: true, values: [0, 1, 1, 2] },
    ],
  };

  it('has a gradient area under the first series, two lines, a legend and an accessible data table', () => {
    const w = mount(LineChart, { props });
    expect(w.findAll('polyline')).toHaveLength(2);
    expect(w.find('polygon').attributes('fill')).toMatch(/^url\(#/);
    expect(w.find('svg').attributes('aria-label')).toContain('New contacts: 15 in total');
    expect(w.findAll('tbody tr')).toHaveLength(4);
    expect(w.find('.legend').text()).toContain('Edits');
  });

  it('shows the values of the day nearest the pointer, and hides them again when it leaves', async () => {
    const w = mount(LineChart, { props, attachTo: document.body });
    const svg = w.find('svg');
    svg.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 180, right: 640, bottom: 180, x: 0, y: 0, toJSON: () => ({}) });
    expect(w.find('.chart-tip').exists()).toBe(false);

    svg.element.dispatchEvent(new MouseEvent('pointermove', { clientX: 636, bubbles: true })); // far right = last day
    await w.vm.$nextTick();
    const tip = w.find('.chart-tip');
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain('Oct 4');
    expect(tip.text()).toContain('New contacts: 8');
    expect(tip.text()).toContain('Edits: 2');
    expect(w.findAll('circle')).toHaveLength(2); // a marker on each line

    svg.element.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, bubbles: true })); // far left = first day
    await w.vm.$nextTick();
    expect(w.find('.chart-tip').text()).toContain('Oct 1');

    svg.element.dispatchEvent(new MouseEvent('pointerleave'));
    await w.vm.$nextTick();
    expect(w.find('.chart-tip').exists()).toBe(false);
    w.unmount();
  });

  it('copes with a single day and with no data', () => {
    expect(() => mount(LineChart, { props: { labels: ['2026-10-01'], series: [{ name: 'A', color: 'red', values: [3] }] } })).not.toThrow();
    expect(() => mount(LineChart, { props: { labels: [], series: [] } })).not.toThrow();
  });
});
