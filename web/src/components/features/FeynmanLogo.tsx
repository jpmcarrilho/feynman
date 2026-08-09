'use client'

import { useState } from 'react'

interface FeynmanLogoProps {
  className?: string
  variant?: 'default' | 'mini' | 'thinking'
  size?: number
}

export function FeynmanLogo({ className = '', variant = 'default', size }: FeynmanLogoProps) {
  const [animationKey, setAnimationKey] = useState(0)

  const handleMouseEnter = () => {
    // Only re-trigger draw animation for non-looping variants
    if (variant !== 'thinking') {
      setAnimationKey((prev) => prev + 1)
    }
  }

  // Set explicit default sizes based on variant
  const defaultSize = variant === 'default' ? 240 : variant === 'mini' ? 48 : 36
  const actualSize = size || defaultSize

  if (variant === 'thinking') {
    return (
      <div 
        className={`relative inline-flex items-center justify-center ${className}`}
        style={{ width: actualSize, height: actualSize }}
      >
        {/* Step 0: Cups */}
        <svg 
          viewBox="115 130 130 130" 
          className="absolute inset-0 w-full h-full animate-unified-loop-0"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 120 170 Q 140 150 175 165 L 175 220 Q 145 235 120 218 Z"/>
            <ellipse cx="147" cy="165" rx="27" ry="12"/>
            <path d="M 175 178 Q 205 160 240 178 L 240 230 Q 205 245 175 225 Z"/>
            <ellipse cx="207" cy="178" rx="28" ry="12"/>
          </g>
        </svg>

        {/* Step 1: Pipe */}
        <svg 
          viewBox="102 112 160 160" 
          className="absolute inset-0 w-full h-full animate-unified-loop-1"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g stroke="var(--charcoal-graphite, #2C2E33)" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 110 190 Q 180 185 230 200" strokeWidth="3.2"/>
            <path d="M 230 200 Q 245 203 245 220 Q 245 238 228 242 Q 210 246 202 232 L 202 208" strokeWidth="3.2"/>
            <path d="M 235 190 Q 242 175 233 162 Q 226 152 235 138" strokeWidth="2"/>
            <path d="M 245 175 Q 255 165 250 150" strokeWidth="1.8"/>
          </g>
        </svg>

        {/* Step 2: Diagram */}
        <svg 
          viewBox="60 110 220 220" 
          className="absolute inset-0 w-full h-full animate-unified-loop-2"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g stroke="var(--charcoal-graphite, #2C2E33)" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <line x1="100" y1="120" x2="170" y2="180" strokeWidth="3.2"/>
            <line x1="240" y1="120" x2="170" y2="180" strokeWidth="3.2"/>
            <path d="M 170 180 Q 195 205 185 240 Q 178 265 200 285" strokeWidth="2.4"/>
            <line x1="200" y1="285" x2="140" y2="270" strokeWidth="3.2"/>
            <line x1="200" y1="285" x2="140" y2="320" strokeWidth="3.2"/>
          </g>
        </svg>

        {/* Step 3: Equation */}
        <svg 
          viewBox="45 35 300 300" 
          className="absolute inset-0 w-full h-full animate-unified-loop-3"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g fontFamily="var(--font-display, Georgia, serif)" fontStyle="italic" fill="var(--charcoal-graphite, #2C2E33)">
            <text x="60" y="140" fontSize="34">∫</text>
            <text x="95" y="135" fontSize="26">ψ(x) dx</text>
            <text x="70" y="200" fontSize="30">e^iπ + 1 = 0</text>
            <text x="90" y="260" fontSize="28">∂/∂t</text>
          </g>
          <path d="M 55 175 Q 200 190 340 170" fill="none" stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="1.8"/>
        </svg>
      </div>
    )
  }

  if (variant === 'mini') {
    return (
      <svg 
        key={animationKey}
        viewBox="85 105 160 160" 
        style={{ width: actualSize, height: actualSize }}
        className={`animate-sketch-draw select-none cursor-pointer ${className}`}
        xmlns="http://www.w3.org/2000/svg"
        onMouseEnter={handleMouseEnter}
      >
        <g stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 120 170 Q 140 150 175 165 L 175 220 Q 145 235 120 218 Z"/>
          <ellipse cx="147" cy="165" rx="27" ry="12"/>
          <path d="M 175 178 Q 205 160 240 178 L 240 230 Q 205 245 175 225 Z"/>
          <ellipse cx="207" cy="178" rx="28" ry="12"/>
          <path d="M 90 130 Q 105 155 115 175" strokeWidth="2"/>
          <path d="M 100 120 Q 118 148 128 170" strokeWidth="2"/>
        </g>
      </svg>
    )
  }

  return (
    <div 
      key={animationKey}
      style={{ width: actualSize, height: actualSize }}
      className={`relative inline-flex flex-col items-center select-none cursor-pointer group ${className}`}
      onMouseEnter={handleMouseEnter}
    >
      <svg 
        viewBox="65 105 210 210" 
        className="w-full h-full animate-sketch-draw"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Transparent background so it fits any notebook page context */}
        <g stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 120 170 Q 140 150 175 165 L 175 220 Q 145 235 120 218 Z"/>
          <ellipse cx="147" cy="165" rx="27" ry="12"/>
          <path d="M 175 178 Q 205 160 240 178 L 240 230 Q 205 245 175 225 Z"/>
          <ellipse cx="207" cy="178" rx="28" ry="12"/>
          <path d="M 90 130 Q 105 155 115 175" strokeWidth="1.6"/>
          <path d="M 100 120 Q 118 148 128 170" strokeWidth="1.6"/>
        </g>
        <text 
          x="200" 
          y="290" 
          fontFamily="var(--font-display, Georgia, serif)" 
          fontSize="24" 
          fontStyle="italic"
          fontWeight="semibold"
          fill="var(--charcoal-graphite, #2C2E33)" 
          textAnchor="middle"
          className="transition-colors duration-300 group-hover:fill-fountain-ink"
        >
          Feynman
        </text>
      </svg>
    </div>
  )
}
