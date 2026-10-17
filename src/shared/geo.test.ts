import { describe, expect, it } from 'vitest'
import { addressValues } from './apply-values'
import { chooseLocationOption, chooseOption, countryOf, locationParts, matchesOption, phoneCountryOf, regionOf } from './geo'

describe('locationParts (#136)', () => {
  it('splits city, state, country and postal code', () => {
    expect(locationParts('Portland, OR')).toEqual({ city: 'Portland', state: 'Oregon', country: 'United States', postalCode: '' })
    expect(locationParts('Austin, Texas')).toEqual({ city: 'Austin', state: 'Texas', country: 'United States', postalCode: '' })
    expect(locationParts('Toronto, ON, Canada')).toEqual({ city: 'Toronto', state: 'Ontario', country: 'Canada', postalCode: '' })
    expect(locationParts('Portland, OR 97201')).toEqual({ city: 'Portland', state: 'Oregon', country: 'United States', postalCode: '97201' })
    expect(locationParts('New York, NY, USA')).toMatchObject({ city: 'New York', state: 'New York', country: 'United States' })
    expect(locationParts('Indianapolis, IN')).toMatchObject({ state: 'Indiana', country: 'United States' })
    expect(locationParts('London, UK')).toEqual({ city: 'London', state: '', country: 'United Kingdom', postalCode: '' })
  })

  it('leaves out what the location does not say', () => {
    expect(locationParts('Remote')).toEqual({ city: '', state: '', country: '', postalCode: '' })
    expect(locationParts('Portland')).toEqual({ city: 'Portland', state: '', country: '', postalCode: '' })
    expect(locationParts('')).toEqual({ city: '', state: '', country: '', postalCode: '' })
    expect(locationParts('Canada')).toMatchObject({ city: '', country: 'Canada' })
  })

  it('derives the address values from the contact block', () => {
    expect(addressValues({ location: 'Portland, OR', postalCode: '', country: '' })).toEqual({
      city: 'Portland',
      state: 'Oregon',
      postalCode: '',
      country: 'United States'
    })
    // The contact's own country and postal code win.
    expect(addressValues({ location: 'Portland, OR 97201', postalCode: '97209', country: 'USA' })).toMatchObject({
      postalCode: '97209',
      country: 'United States'
    })
    expect(addressValues({ location: 'Portland, OR 97201', postalCode: '', country: '' }).postalCode).toBe('97201')
    expect(addressValues({ location: 'Remote', postalCode: '', country: 'Nepal' })).toEqual({ city: '', state: '', postalCode: '', country: 'Nepal' })
  })
})

describe('matching a value to a site option', () => {
  it('knows states, provinces and countries', () => {
    expect(regionOf('or')).toMatchObject({ name: 'Oregon', country: 'United States' })
    expect(regionOf('Quebec')).toMatchObject({ code: 'QC', country: 'Canada' })
    expect(countryOf('U.S.A.')).toBe('United States')
    expect(countryOf('CA', { codes: false })).toBeNull()
  })

  it('matches state codes and names, country synonyms, phone codes and types', () => {
    expect(matchesOption('state', 'Oregon', 'OR')).toBe(true)
    expect(matchesOption('state', 'OR', 'Oregon')).toBe(true)
    expect(matchesOption('state', 'Oregon', 'Maine')).toBe(false)
    expect(matchesOption('country', 'United States', 'United States of America')).toBe(true)
    expect(matchesOption('country', 'USA', 'U.S.')).toBe(true)
    expect(matchesOption('country', 'United States', 'Canada')).toBe(false)
    expect(matchesOption('phoneCountryCode', 'United States', 'United States of America (+1)')).toBe(true)
    expect(matchesOption('phoneCountryCode', 'United States', 'US +1')).toBe(true)
    expect(matchesOption('phoneCountryCode', 'United States', '+1')).toBe(true)
    expect(matchesOption('phoneCountryCode', 'United States', 'Canada (+1)')).toBe(false)
    expect(matchesOption('phoneCountryCode', 'India', '+1')).toBe(false)
    expect(matchesOption('phoneType', 'Mobile', 'Cell')).toBe(true)
    expect(matchesOption('phoneType', 'Mobile', 'Home')).toBe(false)
  })

  it('chooses the one option, preferring the exact wording', () => {
    expect(chooseOption('country', 'United States', ['Canada', 'United States of America', 'United States'])).toBe('United States')
    expect(chooseOption('country', 'United States', ['Canada', 'United States of America'])).toBe('United States of America')
    expect(chooseOption('state', 'Oregon', ['Ohio', 'OR', 'Oklahoma'])).toBe('OR')
    expect(chooseOption('phoneCountryCode', 'United States', ['Canada (+1)', 'United States of America (+1)', 'India (+91)'])).toBe(
      'United States of America (+1)'
    )
    expect(chooseOption('phoneCountryCode', 'United States', ['+1', 'United States (+1)'])).toBe('United States (+1)')
    expect(chooseOption('state', 'Oregon', ['No items.'])).toBeNull()
    expect(chooseOption('country', 'Narnia', ['Canada'])).toBeNull()
  })

  it('picks the right city suggestion, never one in another state', () => {
    const options = ['Portsmouth, New Hampshire, United States', 'Portland, Maine, United States', 'Portland, Oregon, United States']
    expect(chooseLocationOption('Portland, OR', options)).toBe('Portland, Oregon, United States')
    expect(chooseLocationOption('Portland, OR', ['Portland, OR, United States', 'Portland, ME, United States'])).toBe('Portland, OR, United States')
    expect(chooseLocationOption('Portland, OR', ['Portland, Maine, United States'])).toBeNull()
    expect(chooseLocationOption('Portland', ['Portsmouth, NH', 'Portland, Maine'])).toBe('Portland, Maine')
    expect(chooseLocationOption('Portland, OR', ['No location found'])).toBeNull()
    expect(chooseLocationOption('Toronto, ON, Canada', ['Toronto, Ontario, Canada'])).toBe('Toronto, Ontario, Canada')
  })

  it('finds the phone country', () => {
    expect(phoneCountryOf('USA', '')).toBe('United States')
    expect(phoneCountryOf('', '+1 503 555 0100')).toBe('United States')
    expect(phoneCountryOf('', '+44 20 7946 0000')).toBe('')
  })
})
