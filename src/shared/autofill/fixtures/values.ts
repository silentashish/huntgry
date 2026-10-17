import type { FillValues } from '../../apply-types'

/**
 * Fill values for the autofill tests: Ada's contact block, no address unless
 * a test asks for one (`overrides`). One place, so a new `FillValues` key is
 * added once (#136).
 */
export function testValues(overrides: Partial<FillValues> = {}): FillValues {
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+1 555 123 4567',
    location: 'London, UK',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    linkedin: 'https://www.linkedin.com/in/ada',
    github: 'https://github.com/ada',
    website: 'https://ada.example',
    currentCompany: 'Analytical Engines',
    ...overrides
  }
}

/** A US profile with a full address: "Portland, OR", 1 Main St, 97201. */
export const US_ADDRESS: Partial<FillValues> = {
  location: 'Portland, OR',
  addressLine1: '1 Main St',
  city: 'Portland',
  state: 'Oregon',
  postalCode: '97201',
  country: 'United States'
}
