export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      audit_events: {
        Row: {
          action: string;
          actor_kind: string;
          actor_subject: string;
          after: Json | null;
          before: Json | null;
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          request_id: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          action: string;
          actor_kind: string;
          actor_subject: string;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          entity_id: string;
          entity_type: string;
          id?: string;
          request_id: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          action?: string;
          actor_kind?: string;
          actor_subject?: string;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          request_id?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      automation_company_guides: {
        Row: {
          company_id: string;
          company_version: number;
          content: NonNullable<Json>;
          created_at: string;
          id: string;
          source_fingerprint: string;
          user_id: string;
          version: number;
          work_id: string;
        };
        Insert: {
          company_id: string;
          company_version: number;
          content: NonNullable<Json>;
          created_at?: string;
          id?: string;
          source_fingerprint: string;
          user_id: string;
          version: number;
          work_id: string;
        };
        Update: {
          company_id?: string;
          company_version?: number;
          content?: NonNullable<Json>;
          created_at?: string;
          id?: string;
          source_fingerprint?: string;
          user_id?: string;
          version?: number;
          work_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_company_guides_user_id_company_id_fkey";
            columns: ["user_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "automation_company_guides_user_id_work_id_fkey";
            columns: ["user_id", "work_id"];
            isOneToOne: false;
            referencedRelation: "automation_work";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      automation_events: {
        Row: {
          batch_id: string | null;
          created_at: string;
          cycle_id: string | null;
          id: string;
          job_id: string;
          job_version: number | null;
          kind: string;
          mutation_id: string | null;
          profile_id: string;
          snapshot: Json | null;
          user_id: string;
          work_id: string | null;
        };
        Insert: {
          batch_id?: string | null;
          created_at?: string;
          cycle_id?: string | null;
          id?: string;
          job_id: string;
          job_version?: number | null;
          kind: string;
          mutation_id?: string | null;
          profile_id: string;
          snapshot?: Json | null;
          user_id: string;
          work_id?: string | null;
        };
        Update: {
          batch_id?: string | null;
          created_at?: string;
          cycle_id?: string | null;
          id?: string;
          job_id?: string;
          job_version?: number | null;
          kind?: string;
          mutation_id?: string | null;
          profile_id?: string;
          snapshot?: Json | null;
          user_id?: string;
          work_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "automation_events_user_id_batch_id_fkey";
            columns: ["user_id", "batch_id"];
            isOneToOne: false;
            referencedRelation: "notification_batches";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "automation_events_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      automation_interview_intents: {
        Row: {
          active: boolean;
          job_id: string;
          origin: string;
          preparation_context: NonNullable<Json>;
          requested_at: string;
          revision: string;
          user_id: string;
        };
        Insert: {
          active?: boolean;
          job_id: string;
          origin: string;
          preparation_context?: NonNullable<Json>;
          requested_at?: string;
          revision: string;
          user_id: string;
        };
        Update: {
          active?: boolean;
          job_id?: string;
          origin?: string;
          preparation_context?: NonNullable<Json>;
          requested_at?: string;
          revision?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_interview_intents_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: true;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      automation_packs: {
        Row: {
          company_version: number;
          content: NonNullable<Json>;
          created_at: string;
          effort: string;
          id: string;
          job_id: string;
          job_version: number;
          model: string;
          resume_id: string;
          resume_version: number;
          user_id: string;
          version: number;
        };
        Insert: {
          company_version: number;
          content: NonNullable<Json>;
          created_at?: string;
          effort: string;
          id?: string;
          job_id: string;
          job_version: number;
          model: string;
          resume_id: string;
          resume_version: number;
          user_id: string;
          version: number;
        };
        Update: {
          company_version?: number;
          content?: NonNullable<Json>;
          created_at?: string;
          effort?: string;
          id?: string;
          job_id?: string;
          job_version?: number;
          model?: string;
          resume_id?: string;
          resume_version?: number;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "automation_packs_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "automation_packs_user_id_resume_id_fkey";
            columns: ["user_id", "resume_id"];
            isOneToOne: false;
            referencedRelation: "resumes";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      automation_policies: {
        Row: {
          executor_id: string | null;
          executor_status: string | null;
          heartbeat_at: string | null;
          next_digest_at: string;
          policy: NonNullable<Json>;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          executor_id?: string | null;
          executor_status?: string | null;
          heartbeat_at?: string | null;
          next_digest_at?: string;
          policy: NonNullable<Json>;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          executor_id?: string | null;
          executor_status?: string | null;
          heartbeat_at?: string | null;
          next_digest_at?: string;
          policy?: NonNullable<Json>;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      automation_profiles: {
        Row: {
          criteria: NonNullable<Json>;
          id: string;
          next_due_at: string;
          next_revalidation_at: string;
          resume_id: string;
          user_id: string;
        };
        Insert: {
          criteria: NonNullable<Json>;
          id: string;
          next_due_at?: string;
          next_revalidation_at?: string;
          resume_id: string;
          user_id: string;
        };
        Update: {
          criteria?: NonNullable<Json>;
          id?: string;
          next_due_at?: string;
          next_revalidation_at?: string;
          resume_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_profiles_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "automation_policies";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "automation_profiles_user_id_resume_id_fkey";
            columns: ["user_id", "resume_id"];
            isOneToOne: false;
            referencedRelation: "resumes";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      automation_reservations: {
        Row: {
          created_at: string;
          id: string;
          reported_usd: number | null;
          reserved_usd: number;
          user_id: string;
          work_id: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          reported_usd?: number | null;
          reserved_usd: number;
          user_id: string;
          work_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          reported_usd?: number | null;
          reserved_usd?: number;
          user_id?: string;
          work_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_reservations_user_id_work_id_fkey";
            columns: ["user_id", "work_id"];
            isOneToOne: false;
            referencedRelation: "automation_work";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      automation_work: {
        Row: {
          attempts: number;
          checkpoint: NonNullable<Json>;
          created_at: string;
          cycle_id: string | null;
          error: string | null;
          executor_id: string | null;
          id: string;
          job_id: string | null;
          kind: string;
          lease_token: string | null;
          lease_until: string | null;
          next_attempt_at: string;
          parent_work_id: string | null;
          policy_version: number;
          profile_id: string;
          state: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          attempts?: number;
          checkpoint?: NonNullable<Json>;
          created_at?: string;
          cycle_id?: string | null;
          error?: string | null;
          executor_id?: string | null;
          id?: string;
          job_id?: string | null;
          kind: string;
          lease_token?: string | null;
          lease_until?: string | null;
          next_attempt_at?: string;
          parent_work_id?: string | null;
          policy_version: number;
          profile_id: string;
          state?: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          attempts?: number;
          checkpoint?: NonNullable<Json>;
          created_at?: string;
          cycle_id?: string | null;
          error?: string | null;
          executor_id?: string | null;
          id?: string;
          job_id?: string | null;
          kind?: string;
          lease_token?: string | null;
          lease_until?: string | null;
          next_attempt_at?: string;
          parent_work_id?: string | null;
          policy_version?: number;
          profile_id?: string;
          state?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "automation_work_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "automation_policies";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "automation_work_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "automation_work_user_id_parent_work_id_fkey";
            columns: ["user_id", "parent_work_id"];
            isOneToOne: false;
            referencedRelation: "automation_work";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      companies: {
        Row: {
          archived_at: string | null;
          created_at: string;
          domain: string | null;
          id: string;
          linkedin_url: string | null;
          name: string;
          product: string | null;
          type: string | null;
          updated_at: string;
          user_id: string;
          version: number;
          website_url: string | null;
        };
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          domain?: string | null;
          id?: string;
          linkedin_url?: string | null;
          name: string;
          product?: string | null;
          type?: string | null;
          updated_at?: string;
          user_id: string;
          version?: number;
          website_url?: string | null;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          domain?: string | null;
          id?: string;
          linkedin_url?: string | null;
          name?: string;
          product?: string | null;
          type?: string | null;
          updated_at?: string;
          user_id?: string;
          version?: number;
          website_url?: string | null;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          archived_at: string | null;
          company_id: string;
          created_at: string;
          draft_message: string;
          draft_note: string;
          email: string | null;
          id: string;
          invite_at: string | null;
          job_id: string | null;
          last_interacted_at: string | null;
          linkedin_url: string | null;
          name: string;
          notes: string;
          priority: number | null;
          queued_at: string | null;
          resume_id: string | null;
          role: string | null;
          status: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          archived_at?: string | null;
          company_id: string;
          created_at?: string;
          draft_message?: string;
          draft_note?: string;
          email?: string | null;
          id?: string;
          invite_at?: string | null;
          job_id?: string | null;
          last_interacted_at?: string | null;
          linkedin_url?: string | null;
          name: string;
          notes?: string;
          priority?: number | null;
          queued_at?: string | null;
          resume_id?: string | null;
          role?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          archived_at?: string | null;
          company_id?: string;
          created_at?: string;
          draft_message?: string;
          draft_note?: string;
          email?: string | null;
          id?: string;
          invite_at?: string | null;
          job_id?: string | null;
          last_interacted_at?: string | null;
          linkedin_url?: string | null;
          name?: string;
          notes?: string;
          priority?: number | null;
          queued_at?: string | null;
          resume_id?: string | null;
          role?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_user_id_company_id_fkey";
            columns: ["user_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "contacts_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "contacts_user_id_resume_id_fkey";
            columns: ["user_id", "resume_id"];
            isOneToOne: false;
            referencedRelation: "resumes";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      crm_jobs: {
        Row: {
          attempts: number;
          created_at: string;
          error: Json | null;
          id: string;
          kind: string;
          lease_token: string | null;
          lease_until: string | null;
          next_attempt_at: string;
          payload: NonNullable<Json>;
          request_id: string;
          result: Json | null;
          state: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          error?: Json | null;
          id?: string;
          kind: string;
          lease_token?: string | null;
          lease_until?: string | null;
          next_attempt_at?: string;
          payload: NonNullable<Json>;
          request_id: string;
          result?: Json | null;
          state?: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          error?: Json | null;
          id?: string;
          kind?: string;
          lease_token?: string | null;
          lease_until?: string | null;
          next_attempt_at?: string;
          payload?: NonNullable<Json>;
          request_id?: string;
          result?: Json | null;
          state?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      email_preferences: {
        Row: {
          created_at: string;
          enabled: boolean;
          id: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          created_at?: string;
          enabled?: boolean;
          id?: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          id?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      interviews: {
        Row: {
          created_at: string;
          format: string | null;
          id: string;
          interviewer_ids: string[];
          interviewer_notes: string;
          job_id: string;
          language: string | null;
          meeting_url: string | null;
          next_step: string | null;
          notes: string;
          scheduled_at: string | null;
          state: string;
          timezone: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          created_at?: string;
          format?: string | null;
          id?: string;
          interviewer_ids?: string[];
          interviewer_notes?: string;
          job_id: string;
          language?: string | null;
          meeting_url?: string | null;
          next_step?: string | null;
          notes?: string;
          scheduled_at?: string | null;
          state: string;
          timezone: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          created_at?: string;
          format?: string | null;
          id?: string;
          interviewer_ids?: string[];
          interviewer_notes?: string;
          job_id?: string;
          language?: string | null;
          meeting_url?: string | null;
          next_step?: string | null;
          notes?: string;
          scheduled_at?: string | null;
          state?: string;
          timezone?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "interviews_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      jobs: {
        Row: {
          applied_at: string | null;
          applied_date_precision: string | null;
          company_id: string;
          created_at: string;
          currency: string | null;
          description_summary: string | null;
          fit_raw: string | null;
          fit_score: number | null;
          id: string;
          location: string | null;
          notes: string;
          posted_on: string | null;
          posting_url: string | null;
          resume_id: string | null;
          salary_max: number | null;
          salary_min: number | null;
          salary_text: string | null;
          source_id: string | null;
          source_posting_id: string | null;
          stage: string;
          title: string;
          updated_at: string;
          user_id: string;
          version: number;
          viewed: boolean;
          viewed_at: string | null;
        };
        Insert: {
          applied_at?: string | null;
          applied_date_precision?: string | null;
          company_id: string;
          created_at?: string;
          currency?: string | null;
          description_summary?: string | null;
          fit_raw?: string | null;
          fit_score?: number | null;
          id?: string;
          location?: string | null;
          notes?: string;
          posted_on?: string | null;
          posting_url?: string | null;
          resume_id?: string | null;
          salary_max?: number | null;
          salary_min?: number | null;
          salary_text?: string | null;
          source_id?: string | null;
          source_posting_id?: string | null;
          stage?: string;
          title: string;
          updated_at?: string;
          user_id: string;
          version?: number;
          viewed?: boolean;
          viewed_at?: string | null;
        };
        Update: {
          applied_at?: string | null;
          applied_date_precision?: string | null;
          company_id?: string;
          created_at?: string;
          currency?: string | null;
          description_summary?: string | null;
          fit_raw?: string | null;
          fit_score?: number | null;
          id?: string;
          location?: string | null;
          notes?: string;
          posted_on?: string | null;
          posting_url?: string | null;
          resume_id?: string | null;
          salary_max?: number | null;
          salary_min?: number | null;
          salary_text?: string | null;
          source_id?: string | null;
          source_posting_id?: string | null;
          stage?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
          viewed?: boolean;
          viewed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "jobs_user_id_company_id_fkey";
            columns: ["user_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "jobs_user_id_resume_id_fkey";
            columns: ["user_id", "resume_id"];
            isOneToOne: false;
            referencedRelation: "resumes";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "jobs_user_id_source_id_fkey";
            columns: ["user_id", "source_id"];
            isOneToOne: false;
            referencedRelation: "sources";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      legacy_links: {
        Row: {
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          import_namespace: string;
          legacy_id: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          created_at?: string;
          entity_id: string;
          entity_type: string;
          id?: string;
          import_namespace: string;
          legacy_id: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          created_at?: string;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          import_namespace?: string;
          legacy_id?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      mutation_receipts: {
        Row: {
          completed_at: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          operation: string;
          payload_hash: string;
          response: NonNullable<Json>;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          completed_at?: string;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          operation: string;
          payload_hash: string;
          response: NonNullable<Json>;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          completed_at?: string;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          operation?: string;
          payload_hash?: string;
          response?: NonNullable<Json>;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      notification_batches: {
        Row: {
          created_at: string;
          id: string;
          read_at: string | null;
          updated_at: string;
          user_id: string;
          version: number;
          window_end: string;
          window_start: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          read_at?: string | null;
          updated_at?: string;
          user_id: string;
          version?: number;
          window_end: string;
          window_start: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          read_at?: string | null;
          updated_at?: string;
          user_id?: string;
          version?: number;
          window_end?: string;
          window_start?: string;
        };
        Relationships: [];
      };
      notification_state: {
        Row: {
          disclosure: string;
          live_email: boolean;
          user_id: string;
          version: number;
        };
        Insert: {
          disclosure?: string;
          live_email?: boolean;
          user_id: string;
          version?: number;
        };
        Update: {
          disclosure?: string;
          live_email?: boolean;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      outreach_events: {
        Row: {
          body: string;
          channel: string;
          contact_id: string | null;
          created_at: string;
          error: string | null;
          external_ref: string | null;
          id: string;
          job_id: string | null;
          kind: string;
          occurred_at: string | null;
          resume_id: string | null;
          scheduled_for: string | null;
          state: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          body: string;
          channel: string;
          contact_id?: string | null;
          created_at?: string;
          error?: string | null;
          external_ref?: string | null;
          id?: string;
          job_id?: string | null;
          kind: string;
          occurred_at?: string | null;
          resume_id?: string | null;
          scheduled_for?: string | null;
          state?: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          body?: string;
          channel?: string;
          contact_id?: string | null;
          created_at?: string;
          error?: string | null;
          external_ref?: string | null;
          id?: string;
          job_id?: string | null;
          kind?: string;
          occurred_at?: string | null;
          resume_id?: string | null;
          scheduled_for?: string | null;
          state?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "outreach_events_user_id_contact_id_fkey";
            columns: ["user_id", "contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "outreach_events_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "outreach_events_user_id_resume_id_fkey";
            columns: ["user_id", "resume_id"];
            isOneToOne: false;
            referencedRelation: "resumes";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      push_deliveries: {
        Row: {
          attempts: number;
          created_at: string;
          crm_job_id: string;
          id: string;
          lease_token: string | null;
          lease_until: string | null;
          next_attempt_at: string;
          state: string;
          subscription_id: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          crm_job_id: string;
          id?: string;
          lease_token?: string | null;
          lease_until?: string | null;
          next_attempt_at?: string;
          state?: string;
          subscription_id: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          crm_job_id?: string;
          id?: string;
          lease_token?: string | null;
          lease_until?: string | null;
          next_attempt_at?: string;
          state?: string;
          subscription_id?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "push_deliveries_user_id_crm_job_id_fkey";
            columns: ["user_id", "crm_job_id"];
            isOneToOne: false;
            referencedRelation: "crm_jobs";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "push_deliveries_user_id_subscription_id_fkey";
            columns: ["user_id", "subscription_id"];
            isOneToOne: false;
            referencedRelation: "push_subscriptions";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      push_subscriptions: {
        Row: {
          active: boolean;
          auth: string;
          created_at: string;
          device_label: string | null;
          endpoint: string;
          id: string;
          p256dh: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          active?: boolean;
          auth: string;
          created_at?: string;
          device_label?: string | null;
          endpoint: string;
          id?: string;
          p256dh: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          active?: boolean;
          auth?: string;
          created_at?: string;
          device_label?: string | null;
          endpoint?: string;
          id?: string;
          p256dh?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      resumes: {
        Row: {
          active: boolean;
          checksum: string;
          country: string | null;
          created_at: string;
          id: string;
          label: string;
          media_type: string;
          storage_path: string;
          track: string | null;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          active?: boolean;
          checksum: string;
          country?: string | null;
          created_at?: string;
          id?: string;
          label: string;
          media_type: string;
          storage_path: string;
          track?: string | null;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          active?: boolean;
          checksum?: string;
          country?: string | null;
          created_at?: string;
          id?: string;
          label?: string;
          media_type?: string;
          storage_path?: string;
          track?: string | null;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      sources: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          name: string;
          updated_at: string;
          url: string | null;
          user_id: string;
          version: number;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: string;
          name: string;
          updated_at?: string;
          url?: string | null;
          user_id: string;
          version?: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          name?: string;
          updated_at?: string;
          url?: string | null;
          user_id?: string;
          version?: number;
        };
        Relationships: [];
      };
      verifications: {
        Row: {
          checked_at: string;
          company_id: string | null;
          created_at: string;
          evidence_url: string | null;
          id: string;
          job_id: string | null;
          notes: string;
          source_id: string | null;
          status: string;
          updated_at: string;
          user_id: string;
          version: number;
        };
        Insert: {
          checked_at: string;
          company_id?: string | null;
          created_at?: string;
          evidence_url?: string | null;
          id?: string;
          job_id?: string | null;
          notes: string;
          source_id?: string | null;
          status: string;
          updated_at?: string;
          user_id: string;
          version?: number;
        };
        Update: {
          checked_at?: string;
          company_id?: string | null;
          created_at?: string;
          evidence_url?: string | null;
          id?: string;
          job_id?: string | null;
          notes?: string;
          source_id?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "verifications_user_id_company_id_fkey";
            columns: ["user_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "verifications_user_id_job_id_fkey";
            columns: ["user_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "verifications_user_id_source_id_fkey";
            columns: ["user_id", "source_id"];
            isOneToOne: false;
            referencedRelation: "sources";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      crm_authorize: { Args: { p_mcp?: boolean }; Returns: Json };
      crm_email_preferences: { Args: { p_input?: Json }; Returns: Json };
      crm_operation: { Args: { p_input: Json; p_operation: string }; Returns: Json };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
