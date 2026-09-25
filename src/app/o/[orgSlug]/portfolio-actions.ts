"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import type { ActionState } from "@/server/actions";
import {
  addFloor, buildingSchema, createBuilding, createPortfolio, createProperty, createUnit, deleteBuilding, deleteFloor,
  deletePortfolio, deleteProperty, deleteUnit, floorSchema, generateUnits, generateUnitsSchema, portfolioSchema,
  propertySchema, unitSchema, updateBuilding, updatePortfolio, updateProperty, updateUnit,
} from "@/server/modules/portfolio/service";
import {
  addOccupancy, createResident, deleteResident, endOccupancy, inviteResident, moveOutSchema, occupancySchema,
  residentSchema, staffProfileSchema, updateResident, updateStaffProfile,
} from "@/server/modules/people/service";
import {
  addContact, assignVendorProperty, contactSchema, createVendor, deleteVendor, inviteVendorUser, removeContact,
  unassignVendorProperty, updateVendor, vendorSchema,
} from "@/server/modules/vendors/service";

const none = z.object({}).passthrough();
const base = (s: string) => `/o/${s}`;

/* portfolios */
export async function createPortfolioAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: portfolioSchema, run: createPortfolio, done: () => ({ message: "Portfolio created." }) });
}
export async function updatePortfolioAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: portfolioSchema, run: (c, d) => updatePortfolio(c, id, d), done: () => ({ message: "Portfolio saved." }) });
}
export async function deletePortfolioAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deletePortfolio(c, id), done: () => ({ redirectTo: `${base(slug)}/portfolios` }) });
}

/* properties */
export async function createPropertyAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: propertySchema, run: createProperty, done: (p) => ({ redirectTo: `${base(slug)}/properties/${p.id}` }) });
}
export async function updatePropertyAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: propertySchema, run: (c, d) => updateProperty(c, id, d), done: () => ({ redirectTo: `${base(slug)}/properties/${id}` }) });
}
export async function deletePropertyAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({ confirm: z.string().default("") }), run: (c, d) => deleteProperty(c, id, d.confirm), done: () => ({ redirectTo: `${base(slug)}/properties` }) });
}

/* buildings & floors */
export async function createBuildingAction(slug: string, propertyId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: buildingSchema, run: (c, d) => createBuilding(c, propertyId, d), done: (b) => ({ redirectTo: `${base(slug)}/buildings/${b.id}` }) });
}
export async function updateBuildingAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: buildingSchema, run: (c, d) => updateBuilding(c, id, d), done: () => ({ message: "Building saved." }) });
}
export async function deleteBuildingAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteBuilding(c, id), done: (propertyId) => ({ redirectTo: `${base(slug)}/properties/${propertyId}` }) });
}
export async function addFloorAction(slug: string, buildingId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: floorSchema, run: (c, d) => addFloor(c, buildingId, d), done: (f) => ({ message: `${f.name} added.` }) });
}
export async function deleteFloorAction(slug: string, floorId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteFloor(c, floorId), done: () => ({ message: "Floor removed." }) });
}

/* units */
export async function createUnitAction(slug: string, buildingId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: unitSchema, run: (c, d) => createUnit(c, buildingId, d), done: (u) => ({ redirectTo: `${base(slug)}/units/${u.id}` }) });
}
export async function generateUnitsAction(slug: string, buildingId: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: generateUnitsSchema, run: (c, d) => generateUnits(c, buildingId, d),
    done: (r) => ({ message: `Created ${r.created} unit${r.created === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} that already existed` : ""}.` }),
  });
}
export async function updateUnitAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: unitSchema, run: (c, d) => updateUnit(c, id, d), done: () => ({ message: "Unit saved." }) });
}
export async function deleteUnitAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteUnit(c, id), done: (bid) => ({ redirectTo: `${base(slug)}/buildings/${bid}` }) });
}

/* residents */
// occupancy fields stay raw here and are validated only when a unit was chosen
const newResidentSchema = residentSchema.extend({
  buildingId: z.string().optional(), unitNumber: z.string().optional(), relationship: z.string().optional(),
  isPrimary: z.string().optional(), startsOn: z.string().optional(),
});
export async function createResidentAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: newResidentSchema,
    run: async (c, d) => {
      const wantsUnit = !!(d.buildingId || d.unitNumber);
      const occ = wantsUnit ? occupancySchema.parse({ buildingId: d.buildingId, unitNumber: d.unitNumber, relationship: d.relationship, isPrimary: d.isPrimary, startsOn: d.startsOn }) : null;
      const { firstName, lastName, email, phone, notes } = d;
      return createResident(c, { firstName, lastName, email, phone, notes }, occ);
    },
    done: (r) => ({ redirectTo: `${base(slug)}/residents/${r.id}` }),
  });
}
export async function updateResidentAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: residentSchema, run: (c, d) => updateResident(c, id, d), done: () => ({ message: "Resident saved." }) });
}
export async function addOccupancyAction(slug: string, residentId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: occupancySchema, run: (c, d) => addOccupancy(c, residentId, d), done: () => ({ message: "Move-in recorded." }) });
}
export async function endOccupancyAction(slug: string, occupancyId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: moveOutSchema, run: (c, d) => endOccupancy(c, occupancyId, d.endsOn), done: () => ({ message: "Move-out recorded." }) });
}
export async function deleteResidentAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteResident(c, id), done: () => ({ redirectTo: `${base(slug)}/residents` }) });
}
export async function inviteResidentAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => inviteResident(c, id), done: () => ({ message: "Invitation sent." }) });
}

/* staff */
export async function updateStaffAction(slug: string, membershipId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: staffProfileSchema, run: (c, d) => updateStaffProfile(c, membershipId, d), done: () => ({ message: "Profile saved." }) });
}

/* vendors */
const newVendorSchema = vendorSchema.extend({ propertyId: z.string().optional() });
export async function createVendorAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: newVendorSchema,
    run: (c, { propertyId, ...v }) => createVendor(c, v, propertyId ? propertyId : null),
    done: (v) => ({ redirectTo: `${base(slug)}/vendors/${v.id}` }),
  });
}
export async function updateVendorAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: vendorSchema, run: (c, d) => updateVendor(c, id, d), done: () => ({ message: "Vendor saved." }) });
}
export async function deleteVendorAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteVendor(c, id), done: () => ({ redirectTo: `${base(slug)}/vendors` }) });
}
export async function addContactAction(slug: string, vendorId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: contactSchema, run: (c, d) => addContact(c, vendorId, d), done: () => ({ message: "Contact added." }) });
}
export async function removeContactAction(slug: string, contactId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => removeContact(c, contactId), done: () => ({ message: "Contact removed." }) });
}
export async function assignVendorPropertyAction(slug: string, vendorId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({ propertyId: z.string().uuid("Choose a property.") }), run: (c, d) => assignVendorProperty(c, vendorId, d.propertyId), done: () => ({ message: "Vendor approved for property." }) });
}
export async function unassignVendorPropertyAction(slug: string, vendorId: string, propertyId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => unassignVendorProperty(c, vendorId, propertyId), done: () => ({ message: "Removed." }) });
}
export async function inviteVendorUserAction(slug: string, vendorId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email.") }), run: (c, d) => inviteVendorUser(c, vendorId, d.email), done: () => ({ message: "Invitation sent." }) });
}
