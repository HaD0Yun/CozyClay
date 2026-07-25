import unittest
import uuid

from cclay.identity import IdentityError, assign_entity_ids, new_project_id, validate_project_ids


class IdentityTests(unittest.TestCase):
    def test_stable_identity_uuid_clause_6(self):
        value = new_project_id()
        self.assertEqual(value, str(uuid.UUID(value)))
        self.assertEqual(uuid.UUID(value).version, 4)

    def test_rename_keeps_id_and_only_new_assignments_clause_6(self):
        entity_id = new_project_id()
        existing = {"renamed": entity_id}
        self.assertEqual(assign_entity_ids(existing, ["renamed"]), {})
        added = assign_entity_ids(existing, ["renamed", "new"])
        self.assertEqual(set(added), {"new"})

    def test_duplicates_keep_first_and_reassign_later_clause_6(self):
        duplicate = new_project_id()
        assigned = assign_entity_ids({"first": duplicate, "second": duplicate}, ["first", "second"])
        self.assertEqual(set(assigned), {"second"})
        self.assertNotEqual(assigned["second"], duplicate)

    def test_persisted_project_id_mismatch_rejected_clause_6(self):
        value = new_project_id()
        self.assertEqual(validate_project_ids(value, value), value)
        for scene, store in [(value, new_project_id()), (None, value), ("BAD", "BAD")]:
            with self.subTest(scene=scene, store=store), self.assertRaises(IdentityError):
                validate_project_ids(scene, store)


if __name__ == "__main__":
    unittest.main()
