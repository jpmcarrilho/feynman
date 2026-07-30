import { describe, it, expect, vi } from 'vitest'
import { explainMistake } from './actions'
import { generateText } from 'ai'

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
}))

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn(() => 'mocked-google-model'),
}))

describe('explainMistake action', () => {
  it('calls generateText with the constructed prompt and returns text', async () => {
    const mockExplanation = 'This is the AI explanation.'
    vi.mocked(generateText).mockResolvedValueOnce({ text: mockExplanation } as any)

    const result = await explainMistake({
      questionText: 'What is 2+2?',
      choices: ['3', '4', '5'],
      correctAnswer: '4',
      userAnswer: '5',
      explanation: 'Basic math.',
      topicTitle: 'Math 101'
    })

    expect(generateText).toHaveBeenCalledTimes(1)
    
    const callArgs = vi.mocked(generateText).mock.calls[0][0]
    expect(callArgs.prompt).toContain('What is 2+2?')
    expect(callArgs.prompt).toContain('Student\'s Answer: 5')
    
    expect(result).toBe(mockExplanation)
  })

  it('handles errors gracefully', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('API Error'))

    const result = await explainMistake({
      questionText: 'What is 2+2?',
      choices: ['3', '4', '5'],
      correctAnswer: '4',
      userAnswer: '5'
    })

    expect(result).toContain('Sorry, I encountered an error')
  })
})
