"""
probes/users.py — local user accounts.

Source: Win32_UserAccount filtered by LocalAccount=True. We capture
name, disabled state, SID, and password-expires-never flag — useful
for spotting hardening drift across the fleet.

Last-logon is intentionally NOT included here because it's only reliably
gathered via Net API or NetUserGetInfo (level 2/3), which is finicky.
The dashboard can call that out as "future enhancement" without
blocking the v0.1.0 ship.
"""


def collect():
    try:
        import wmi
        c = wmi.WMI()

        accounts = [
            {
                "name": u.Name,
                "fullName": u.FullName,
                "disabled": bool(u.Disabled),
                "lockout": bool(u.Lockout),
                "passwordExpires": bool(u.PasswordExpires),
                "passwordRequired": bool(u.PasswordRequired),
                "sid": u.SID,
                "sidType": u.SIDType,  # 1=user, 4=well-known group
            }
            for u in c.Win32_UserAccount(LocalAccount=True)
        ]

        return {"accounts": accounts}

    except Exception as e:
        return {"_error": f"users probe failed: {e}"}
