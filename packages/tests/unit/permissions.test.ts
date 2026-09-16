import { describe, it, expect } from 'vitest';

const PERMISSIONS: Record<string, Record<string, boolean>> = {
  view:            { viewer: true,  commenter: true,  editor: true,  owner: true  },
  receive_edits:   { viewer: true,  commenter: true,  editor: true,  owner: true  },
  see_presence:    { viewer: true,  commenter: true,  editor: true,  owner: true  },
  add_comment:     { viewer: false, commenter: true,  editor: true,  owner: true  },
  resolve_comment: { viewer: false, commenter: true,  editor: true,  owner: true  },
  edit_content:    { viewer: false, commenter: false, editor: true,  owner: true  },
  upload_asset:    { viewer: false, commenter: false, editor: true,  owner: true  },
  invite:          { viewer: false, commenter: false, editor: false, owner: true  },
  revoke:          { viewer: false, commenter: false, editor: false, owner: true  },
  delete_doc:      { viewer: false, commenter: false, editor: false, owner: true  },
  transfer_owner:  { viewer: false, commenter: false, editor: false, owner: true  },
};

function hasPermission(role: string, action: string): boolean {
  return PERMISSIONS[action]?.[role] ?? false;
}

describe('Permission Matrix', () => {
  const roles = ['viewer', 'commenter', 'editor', 'owner'] as const;
  const actions = Object.keys(PERMISSIONS);

  for (const action of actions) {
    for (const role of roles) {
      const expected = PERMISSIONS[action][role];
      it(`${role} ${expected ? 'CAN' : 'CANNOT'} ${action}`, () => {
        expect(hasPermission(role, action)).toBe(expected);
      });
    }
  }

  it('rejects unknown roles', () => {
    expect(hasPermission('hacker', 'edit_content')).toBe(false);
  });

  it('rejects unknown actions', () => {
    expect(hasPermission('editor', 'nuke_everything')).toBe(false);
  });
});
