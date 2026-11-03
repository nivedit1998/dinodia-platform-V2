SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_URL'),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 8000
      );
