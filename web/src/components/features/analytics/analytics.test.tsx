import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopicEvolutionChart } from './TopicEvolutionChart'
import { AccuracyHeatmap } from './AccuracyHeatmap'

const evolution = { courseData: [], weekData: [{ date: '2026-11-01', 'Week 1': 50 }], topicData: [] }
const week = (w: string) => ({ week: w, accuracy: 70, total: 4, classes: [] })

describe('analytics inside one studyspace', () => {
  it('evolution chart: no course level, the week level is labelled Module and is the default', () => {
    render(<TopicEvolutionChart evolutionData={evolution} />)
    expect(screen.queryByRole('button', { name: /course/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /module/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /topic/i })).toBeInTheDocument()
  })

  it('heatmap: described by modules, and the single course is not a heading', () => {
    render(<AccuracyHeatmap heatmapData={[{ course: '14.750x', weeks: [week('Week_01_Intro')] }]} />)
    expect(screen.getByText(/across modules/i)).toBeInTheDocument()
    expect(screen.queryByText(/courses/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '14.750x' })).not.toBeInTheDocument()
    expect(screen.getByText('Week 01 Intro')).toBeInTheDocument()
  })

  it('heatmap: with several courses each keeps its heading', () => {
    render(<AccuracyHeatmap heatmapData={[{ course: 'A', weeks: [week('W1')] }, { course: 'B', weeks: [week('W1')] }]} />)
    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'B' })).toBeInTheDocument()
  })
})
